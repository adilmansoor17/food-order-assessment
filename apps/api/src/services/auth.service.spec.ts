import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { DataSource, type QueryRunner } from 'typeorm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../models/auth.types.js';
import { decryptDelivery } from '../utils/auth-security.js';
import { AuthService } from './auth.service.js';

const encryptionKey = Buffer.alloc(32, 7);
const configValues: Record<string, string> = {
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  OTP_PEPPER: 'c'.repeat(40),
  OTP_ENCRYPTION_KEY: encryptionKey.toString('base64'),
  AUTH_TOKEN_HASH_SECRET: 'd'.repeat(40),
};

interface Challenge {
  id: string;
  user_id: string;
  channel: 'email' | 'phone';
  purpose: 'login';
  code_hash: string;
  delivery_ciphertext: string;
  delivery_nonce: string;
  delivery_tag: string;
  attempts_remaining: number;
  expires_at: Date;
  consumed_at: Date | null;
  superseded_at: Date | null;
}

class FakeAuthDb {
  users = new Map<string, UserRow>();
  challenges = new Map<string, Challenge>();
  sessions: Array<{ id: string; userId: string }> = [];
  outbox: Array<{ eventType: string; payload: unknown }> = [];
  committed = 0;

  async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    if (sql.includes('auth_rate_counters')) return [{ count: 1 }];
    if (sql.startsWith('INSERT INTO users')) {
      const [id, name, email, phone, passwordHash] = params as string[];
      this.users.set(id, {
        id,
        name,
        email,
        phone_e164: phone,
        password_hash: passwordHash,
        role: 'customer',
        status: 'active',
        created_at: new Date(),
      });
      return [];
    }
    if (sql.startsWith('SELECT * FROM users WHERE id')) {
      const user = this.users.get(params[0] as string);
      return user ? [user] : [];
    }
    if (sql.includes('SELECT id FROM users WHERE id')) {
      return this.users.has(params[0] as string) ? [{ id: params[0] }] : [];
    }
    if (sql.includes('SELECT * FROM users WHERE email')) {
      const user = [...this.users.values()].find(
        (row) => row.email === params[0] || row.phone_e164 === params[0],
      );
      return user ? [user] : [];
    }
    if (sql.startsWith('UPDATE otp_challenges') && sql.includes('superseded_at')) {
      for (const challenge of this.challenges.values()) {
        if (challenge.user_id === params[0] && challenge.channel === params[1] && !challenge.consumed_at) {
          challenge.superseded_at = new Date();
        }
      }
      return [];
    }
    if (sql.startsWith('INSERT INTO otp_challenges')) {
      const [id, userId, channel, codeHash, ciphertext, nonce, tag] = params as string[];
      this.challenges.set(id, {
        id,
        user_id: userId,
        channel: channel as Challenge['channel'],
        purpose: 'login',
        code_hash: codeHash,
        delivery_ciphertext: ciphertext,
        delivery_nonce: nonce,
        delivery_tag: tag,
        attempts_remaining: 5,
        expires_at: new Date(Date.now() + 300_000),
        consumed_at: null,
        superseded_at: null,
      });
      return [];
    }
    if (sql.startsWith('INSERT INTO outbox')) {
      this.outbox.push({ eventType: 'otp.send', payload: JSON.parse(params[2] as string) });
      return [];
    }
    if (sql.startsWith('SELECT user_id FROM otp_challenges')) {
      const challenge = this.challenges.get(params[0] as string);
      return challenge ? [{ user_id: challenge.user_id }] : [];
    }
    if (sql.startsWith('SELECT * FROM otp_challenges')) {
      const challenge = this.challenges.get(params[0] as string);
      return challenge ? [challenge] : [];
    }
    if (sql.startsWith('UPDATE otp_challenges') && sql.includes('attempts_remaining - 1')) {
      const challenge = this.challenges.get(params[0] as string)!;
      challenge.attempts_remaining -= 1;
      if (challenge.attempts_remaining === 0) challenge.consumed_at = new Date();
      return [];
    }
    if (sql.startsWith('UPDATE otp_challenges') && sql.includes('consumed_at = now()')) {
      this.challenges.get(params[0] as string)!.consumed_at = new Date();
      return [];
    }
    if (sql.startsWith('INSERT INTO sessions')) {
      this.sessions.push({ id: params[0] as string, userId: params[1] as string });
      return [];
    }
    throw new Error(`Unexpected test query: ${sql}`);
  }

  dataSource(): DataSource {
    const query = this.query.bind(this);
    const runner = {
      connect: async () => undefined,
      startTransaction: async () => undefined,
      commitTransaction: async () => {
        this.committed += 1;
      },
      rollbackTransaction: async () => undefined,
      release: async () => undefined,
      query,
    } as unknown as QueryRunner;
    return { query, createQueryRunner: () => runner } as unknown as DataSource;
  }
}

describe('AuthService PDF flows', () => {
  let db: FakeAuthDb;
  let service: AuthService;

  beforeEach(() => {
    db = new FakeAuthDb();
    const config = { get: (key: string) => configValues[key] } as ConfigService;
    service = new AuthService(db.dataSource(), new JwtService(), config);
  });

  it('registers an active account and issues tokens without an OTP', async () => {
    const session = await service.register(
      { name: 'Ada', email: 'ADA@Example.com', phone: '+447700900123', password: 'correct horse battery' },
      '127.0.0.1',
    );
    const user = db.users.get(session.user.id)!;
    expect(user.status).toBe('active');
    expect(user.email).toBe('ada@example.com');
    expect(await bcrypt.compare('correct horse battery', user.password_hash)).toBe(true);
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
    expect(db.sessions).toHaveLength(1);
    expect(db.challenges).toHaveProperty('size', 0);
    expect(db.outbox).toHaveLength(0);
    expect(db.committed).toBe(1);
  });

  it.each(['ada@example.com', '+447700900123'])(
    'logs in with password using %s',
    async (identifier) => {
      const userId = randomUUID();
      db.users.set(userId, {
        id: userId,
        name: 'Ada',
        email: 'ada@example.com',
        phone_e164: '+447700900123',
        password_hash: await bcrypt.hash('correct horse battery', 4),
        role: 'customer',
        status: 'active',
        created_at: new Date(),
      });
      const session = await service.passwordLogin(identifier, 'correct horse battery', '127.0.0.1');
      expect(session.user.id).toBe(userId);
      expect(session.accessToken).toBeTruthy();
      expect(db.sessions).toHaveLength(1);
    },
  );

  it('uses a five-minute one-time OTP and keeps the code out of the queue', async () => {
    const userId = randomUUID();
    db.users.set(userId, {
      id: userId,
      name: 'Ada',
      email: 'ada@example.com',
      phone_e164: '+447700900123',
      password_hash: 'unused',
      role: 'customer',
      status: 'active',
      created_at: new Date(),
    });
    const issued = await service.requestLoginOtp('ada@example.com', 'email', '127.0.0.1');
    const challenge = db.challenges.get(issued.challengeId)!;
    const code = decryptDelivery(encryptionKey, {
      ciphertext: challenge.delivery_ciphertext,
      nonce: challenge.delivery_nonce,
      tag: challenge.delivery_tag,
    }).code;
    expect(issued.expiresInSeconds).toBe(300);
    expect(db.outbox).toEqual([{ eventType: 'otp.send', payload: { challengeId: issued.challengeId } }]);
    await expect(service.verifyLoginOtp(issued.challengeId, '000000' === code ? '000001' : '000000', '127.0.0.1'))
      .rejects.toBeInstanceOf(HttpException);
    expect(challenge.attempts_remaining).toBe(4);
    const session = await service.verifyLoginOtp(issued.challengeId, code, '127.0.0.1');
    expect(session.user.id).toBe(userId);
    await expect(service.verifyLoginOtp(issued.challengeId, code, '127.0.0.1'))
      .rejects.toBeInstanceOf(HttpException);
    const next = await service.requestLoginOtp('ada@example.com', 'email', '127.0.0.1');
    const expiring = db.challenges.get(next.challengeId)!;
    const nextCode = decryptDelivery(encryptionKey, {
      ciphertext: expiring.delivery_ciphertext,
      nonce: expiring.delivery_nonce,
      tag: expiring.delivery_tag,
    }).code;
    expiring.expires_at = new Date(Date.now() - 1);
    await expect(service.verifyLoginOtp(next.challengeId, nextCode, '127.0.0.1'))
      .rejects.toBeInstanceOf(HttpException);
  });

  it('does not send an SMS when an email identifier requests the phone channel', async () => {
    const userId = randomUUID();
    db.users.set(userId, {
      id: userId,
      name: 'Ada',
      email: 'ada@example.com',
      phone_e164: '+447700900123',
      password_hash: 'unused',
      role: 'customer',
      status: 'active',
      created_at: new Date(),
    });
    const issued = await service.requestLoginOtp('ada@example.com', 'phone', '127.0.0.1');
    expect(issued.challengeId).toBeTruthy();
    expect(db.challenges.size).toBe(0);
    expect(db.outbox).toHaveLength(0);
  });
});
