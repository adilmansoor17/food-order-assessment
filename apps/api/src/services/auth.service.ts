import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { DataSource, type QueryRunner } from 'typeorm';
import type { PublicUser } from '../models/user.types.js';
import {
  encryptDelivery,
  generateOtp,
  keyedDigest,
  normalizeEmail,
  normalizeIdentifier,
  normalizePhone,
  parseEncryptionKey,
  safeHexEqual,
} from '../utils/auth-security.js';
import type {
  AuthSessionResult,
  OtpChannel,
  RefreshClaims,
  UserRow,
} from '../models/auth.types.js';
import { publicUser } from '../models/auth.types.js';
import { consumeRateLimit } from '../utils/rate-limit.js';

const JWT_ISSUER = 'food-ordering-api';
const JWT_AUDIENCE = 'food-ordering-web';
const OTP_TTL_SECONDS = 300;

interface OtpRow {
  id: string;
  user_id: string;
  channel: OtpChannel;
  purpose: 'login';
  code_hash: string;
  attempts_remaining: number;
  expires_at: Date;
  consumed_at: Date | null;
  superseded_at: Date | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

function authError(status: HttpStatus, code: string, message: string): never {
  throw new HttpException({ code, message }, status);
}

function isActive(row: Pick<UserRow, 'status'>): boolean {
  return row.status === 'active';
}

function isPgUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  if ('driverError' in error && typeof error.driverError === 'object' && error.driverError !== null) {
    return 'code' in error.driverError && error.driverError.code === '23505';
  }
  return false;
}

@Injectable()
export class AuthService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly otpPepper: string;
  private readonly tokenHashSecret: string;
  private readonly rateKeySecret: string;
  private readonly encryptionKey: Buffer;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;

  constructor(
    private readonly db: DataSource,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.accessSecret = this.required('JWT_ACCESS_SECRET');
    this.refreshSecret = this.required('JWT_REFRESH_SECRET');
    this.otpPepper = this.required('OTP_PEPPER');
    this.tokenHashSecret = this.required('AUTH_TOKEN_HASH_SECRET');
    this.rateKeySecret = this.tokenHashSecret;
    this.encryptionKey = parseEncryptionKey(this.required('OTP_ENCRYPTION_KEY'));
    this.accessTtlSeconds = this.ttl('JWT_ACCESS_TTL_SECONDS', 900);
    this.refreshTtlSeconds = this.ttl('JWT_REFRESH_TTL_SECONDS', 30 * 24 * 60 * 60);
  }

  private required(key: string): string {
    const value = this.config.get<string>(key);
    if (!value || value.length < 32) {
      throw new Error(`${key} must be configured with at least 32 characters`);
    }
    return value;
  }

  private ttl(key: string, defaultValue: number): number {
    const value = Number(this.config.get<string>(key) ?? defaultValue);
    if (!Number.isSafeInteger(value) || value < 60) {
      throw new Error(`${key} must be an integer of at least 60 seconds`);
    }
    return value;
  }

  private async transaction<T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> {
    const runner = this.db.createQueryRunner();
    let transactionStarted = false;
    try {
      await runner.connect();
      await runner.startTransaction();
      transactionStarted = true;
      const result = await work(runner);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      if (transactionStarted || runner.isTransactionActive) {
        await runner.rollbackTransaction().catch(() => undefined);
      }
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async limit(
    scope: string,
    subject: string,
    max: number,
    windowSeconds: number,
  ): Promise<void> {
    await consumeRateLimit(this.db, this.rateKeySecret, scope, subject, max, windowSeconds);
  }

  private async limitIp(scope: string, ip: string, max: number, windowSeconds: number): Promise<void> {
    await this.limit(scope, `ip:${ip}`, max, windowSeconds);
  }

  private async issueOtp(
    runner: QueryRunner,
    user: UserRow,
    channel: OtpChannel,
  ): Promise<string> {
    // Serialize concurrent resends so the partial unique index always sees one open challenge.
    await runner.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
    await runner.query(
      `UPDATE otp_challenges
       SET superseded_at = now(), delivery_ciphertext = NULL,
           delivery_nonce = NULL, delivery_tag = NULL
       WHERE user_id = $1 AND channel = $2 AND purpose = 'login'
         AND consumed_at IS NULL AND superseded_at IS NULL`,
      [user.id, channel],
    );
    const challengeId = randomUUID();
    const code = generateOtp();
    const destination = channel === 'email' ? user.email : user.phone_e164;
    const encrypted = encryptDelivery(this.encryptionKey, { destination, code });
    await runner.query(
      `INSERT INTO otp_challenges
       (id, user_id, channel, purpose, code_hash, delivery_ciphertext,
        delivery_nonce, delivery_tag, attempts_remaining, expires_at)
       VALUES ($1, $2, $3, 'login', $4, $5, $6, $7, 5, now() + interval '5 minutes')`,
      [
        challengeId,
        user.id,
        channel,
        keyedDigest(this.otpPepper, `${challengeId}:${code}`),
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
      ],
    );
    await runner.query(
      `INSERT INTO outbox (id, event_type, aggregate_id, payload)
       VALUES ($1, 'otp.send', $2, $3::jsonb)`,
      [randomUUID(), challengeId, JSON.stringify({ challengeId })],
    );
    return challengeId;
  }

  async register(
    input: { name: string; email: string; phone: string; password: string },
    ip: string,
  ): Promise<AuthSessionResult> {
    const name = input.name.trim();
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    if (Buffer.byteLength(input.password, 'utf8') > 72) {
      authError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Password is too long');
    }
    await this.limitIp('register', ip, 5, 3600);
    await this.limit('register', `identity:${email}:${phone}`, 3, 86400);
    const passwordHash = await bcrypt.hash(input.password, 12);
    try {
      return await this.transaction(async (runner) => {
        const userId = randomUUID();
        await runner.query(
          `INSERT INTO users (id, name, email, phone_e164, password_hash, role, status)
           VALUES ($1, $2, $3, $4, $5, 'customer', 'active')`,
          [userId, name, email, phone, passwordHash],
        );
        const rows = (await runner.query('SELECT * FROM users WHERE id = $1', [userId])) as UserRow[];
        return this.createSession(runner, rows[0]);
      });
    } catch (error) {
      if (isPgUniqueViolation(error)) {
        authError(HttpStatus.CONFLICT, 'IDENTITY_IN_USE', 'Identity is already in use');
      }
      throw error;
    }
  }

  async requestLoginOtp(
    identifier: string,
    channel: OtpChannel,
    ip: string,
  ): Promise<{ challengeId: string; expiresInSeconds: number }> {
    const normalized = normalizeIdentifier(identifier);
    await this.limitIp('login-otp', ip, 10, 3600);
    await this.limit('login-otp', `identity:${normalized}`, 5, 3600);
    const identifierChannel: OtpChannel = normalized.includes('@') ? 'email' : 'phone';
    if (identifierChannel !== channel) {
      return { challengeId: randomUUID(), expiresInSeconds: OTP_TTL_SECONDS };
    }
    const challengeId = await this.transaction(async (runner) => {
      const rows = (await runner.query(
        `SELECT * FROM users WHERE email = $1 OR phone_e164 = $1 FOR UPDATE`,
        [normalized],
      )) as UserRow[];
      const user = rows[0];
      if (!user || !isActive(user)) {
        return randomUUID();
      }
      return this.issueOtp(runner, user, channel);
    });
    return { challengeId, expiresInSeconds: OTP_TTL_SECONDS };
  }

  async verifyLoginOtp(
    challengeId: string,
    code: string,
    ip: string,
  ): Promise<AuthSessionResult> {
    await this.limitIp('verify-otp', ip, 30, 900);
    const result = await this.transaction(async (runner): Promise<AuthSessionResult | null> => {
      const challengeIdentity = (await runner.query(
        'SELECT user_id FROM otp_challenges WHERE id = $1',
        [challengeId],
      )) as Array<{ user_id: string }>;
      if (!challengeIdentity[0]) return null;
      // Lock in the same order as OTP issuance to avoid resend/verify deadlocks.
      const users = (await runner.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [
        challengeIdentity[0].user_id,
      ])) as UserRow[];
      const user = users[0];
      if (!user || !isActive(user)) return null;
      const challenges = (await runner.query(
        'SELECT * FROM otp_challenges WHERE id = $1 FOR UPDATE',
        [challengeId],
      )) as OtpRow[];
      const challenge = challenges[0];
      if (
        !challenge ||
        challenge.purpose !== 'login' ||
        challenge.user_id !== user.id ||
        challenge.consumed_at !== null ||
        challenge.superseded_at !== null ||
        Number(challenge.attempts_remaining) <= 0 ||
        new Date(challenge.expires_at).getTime() <= Date.now()
      ) {
        return null;
      }
      const expected = keyedDigest(this.otpPepper, `${challengeId}:${code}`);
      if (!safeHexEqual(challenge.code_hash, expected)) {
        await runner.query(
          `UPDATE otp_challenges
           SET attempts_remaining = attempts_remaining - 1,
               consumed_at = CASE WHEN attempts_remaining = 1 THEN now() ELSE consumed_at END,
               delivery_ciphertext = CASE WHEN attempts_remaining = 1 THEN NULL ELSE delivery_ciphertext END,
               delivery_nonce = CASE WHEN attempts_remaining = 1 THEN NULL ELSE delivery_nonce END,
               delivery_tag = CASE WHEN attempts_remaining = 1 THEN NULL ELSE delivery_tag END
           WHERE id = $1`,
          [challengeId],
        );
        return null;
      }
      await runner.query(
        `UPDATE otp_challenges
         SET consumed_at = now(), delivery_ciphertext = NULL,
             delivery_nonce = NULL, delivery_tag = NULL
         WHERE id = $1`,
        [challengeId],
      );
      return this.createSession(runner, user);
    });
    if (!result) {
      authError(HttpStatus.UNAUTHORIZED, 'INVALID_OR_EXPIRED_OTP', 'Invalid or expired code');
    }
    return result;
  }

  async passwordLogin(
    identifier: string,
    password: string,
    ip: string,
  ): Promise<AuthSessionResult> {
    const normalized = normalizeIdentifier(identifier);
    await this.limitIp('password-login', ip, 20, 900);
    await this.limit('password-login', `identity:${normalized}`, 10, 900);
    if (Buffer.byteLength(password, 'utf8') > 72) {
      authError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }
    const rows = (await this.db.query(
      `SELECT * FROM users WHERE email = $1 OR phone_e164 = $1`,
      [normalized],
    )) as UserRow[];
    const user = rows[0];
    const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!valid || !user || !isActive(user)) {
      if (!user) {
        // Spend a comparable bcrypt work factor for an unknown identity.
        await bcrypt.hash(password, 12);
      }
      authError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }
    return this.transaction(async (runner) => {
      const current = (await runner.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [
        user.id,
      ])) as UserRow[];
      if (!current[0] || !isActive(current[0])) {
        authError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }
      return this.createSession(runner, current[0]);
    });
  }

  private async createSession(
    runner: QueryRunner,
    user: UserRow,
    familyId: string = randomUUID(),
  ): Promise<AuthSessionResult> {
    const sessionId = randomUUID();
    const accessExpiresAt = new Date(Date.now() + this.accessTtlSeconds * 1000);
    const refreshExpiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000);
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, sid: sessionId, typ: 'access' },
      {
        secret: this.accessSecret,
        expiresIn: this.accessTtlSeconds,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, sid: sessionId, fid: familyId, typ: 'refresh' },
      {
        secret: this.refreshSecret,
        expiresIn: this.refreshTtlSeconds,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      },
    );
    await runner.query(
      `INSERT INTO sessions (id, user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, user.id, familyId, keyedDigest(this.tokenHashSecret, refreshToken), refreshExpiresAt],
    );
    return { user: publicUser(user), accessToken, accessExpiresAt: accessExpiresAt.toISOString(), refreshToken };
  }

  private async decodeRefresh(token: string, ignoreExpiration = false): Promise<RefreshClaims> {
    try {
      const claims = await this.jwt.verifyAsync<RefreshClaims>(token, {
        secret: this.refreshSecret,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        ignoreExpiration,
      });
      if (claims.typ !== 'refresh' || !claims.sub || !claims.sid || !claims.fid) {
        authError(HttpStatus.UNAUTHORIZED, 'SESSION_EXPIRED', 'Session expired');
      }
      return claims;
    } catch {
      authError(HttpStatus.UNAUTHORIZED, 'SESSION_EXPIRED', 'Session expired');
    }
  }

  async refresh(token: string): Promise<AuthSessionResult> {
    const claims = await this.decodeRefresh(token);
    const result = await this.transaction(async (runner): Promise<AuthSessionResult | null> => {
      const rows = (await runner.query(
        `SELECT s.* FROM sessions s WHERE s.id = $1 AND s.user_id = $2 FOR UPDATE`,
        [claims.sid, claims.sub],
      )) as SessionRow[];
      const session = rows[0];
      if (!session || session.family_id !== claims.fid) {
        return null;
      }
      const matches = safeHexEqual(
        session.token_hash,
        keyedDigest(this.tokenHashSecret, token),
      );
      if (
        !matches ||
        session.revoked_at !== null ||
        new Date(session.expires_at).getTime() <= Date.now()
      ) {
        // Reuse of an old refresh token revokes every token in its rotation family.
        await runner.query(
          `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
           WHERE user_id = $1 AND family_id = $2 AND revoked_at IS NULL`,
          [claims.sub, claims.fid],
        );
        return null;
      }
      const users = (await runner.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [
        claims.sub,
      ])) as UserRow[];
      if (!users[0] || !isActive(users[0])) {
        await runner.query(
          `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
           WHERE user_id = $1 AND family_id = $2 AND revoked_at IS NULL`,
          [claims.sub, claims.fid],
        );
        return null;
      }
      await runner.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [session.id]);
      return this.createSession(runner, users[0], session.family_id);
    });
    if (!result) {
      authError(HttpStatus.UNAUTHORIZED, 'SESSION_EXPIRED', 'Session expired');
    }
    return result;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    let claims: RefreshClaims;
    try {
      claims = await this.decodeRefresh(token, true);
    } catch {
      return;
    }
    await this.db.query(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1 AND family_id = $2`,
      [claims.sub, claims.fid],
    );
  }

  async activeUserForAccess(sessionId: string, userId: string): Promise<Pick<UserRow, 'id' | 'role'> | null> {
    const rows = (await this.db.query(
      `SELECT u.id, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
         AND s.expires_at > now() AND u.status = 'active'`,
      [sessionId, userId],
    )) as Array<Pick<UserRow, 'id' | 'role'>>;
    return rows[0] ?? null;
  }

  async me(userId: string): Promise<PublicUser> {
    const rows = (await this.db.query(
      'SELECT id, name, email, phone_e164, role, status FROM users WHERE id = $1', [userId],
    )) as Array<Pick<UserRow, 'id' | 'name' | 'email' | 'phone_e164' | 'role' | 'status'>>;
    if (!rows[0] || !isActive(rows[0])) {
      authError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
    }
    return publicUser(rows[0]);
  }

  /** Called periodically by the worker; each pass has a fixed upper bound. */
  async cleanupExpiredAuthData(batchSize = 500): Promise<{
    clearedOtpPayloads: number;
    deletedChallenges: number;
    deletedRateCounters: number;
  }> {
    const limit = Math.max(1, Math.min(500, Math.trunc(batchSize) || 500));
    const cleared = (await this.db.query(
      `WITH stale AS (
         SELECT id FROM otp_challenges
         WHERE delivery_ciphertext IS NOT NULL
           AND (expires_at <= now() OR consumed_at IS NOT NULL OR superseded_at IS NOT NULL)
         ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE otp_challenges c
       SET delivery_ciphertext = NULL, delivery_nonce = NULL, delivery_tag = NULL
       FROM stale WHERE c.id = stale.id RETURNING c.id`,
      [limit],
    )) as Array<{ id: string }>;
    const deletedChallenges = (await this.db.query(
      `WITH stale AS (
         SELECT id FROM otp_challenges
         WHERE expires_at < now() - interval '24 hours'
         ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM otp_challenges c USING stale
       WHERE c.id = stale.id RETURNING c.id`,
      [limit],
    )) as Array<{ id: string }>;
    const deletedCounters = (await this.db.query(
      `WITH stale AS (
         SELECT key, window_start FROM auth_rate_counters
         WHERE window_start < now() - interval '24 hours'
         ORDER BY window_start, key LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM auth_rate_counters c USING stale
       WHERE c.key = stale.key AND c.window_start = stale.window_start
       RETURNING c.key`,
      [limit],
    )) as Array<{ key: string }>;
    return {
      clearedOtpPayloads: cleared.length,
      deletedChallenges: deletedChallenges.length,
      deletedRateCounters: deletedCounters.length,
    };
  }

  accessTokenSecret(): string {
    return this.accessSecret;
  }

  jwtIssuer(): string {
    return JWT_ISSUER;
  }

  jwtAudience(): string {
    return JWT_AUDIENCE;
  }
}
