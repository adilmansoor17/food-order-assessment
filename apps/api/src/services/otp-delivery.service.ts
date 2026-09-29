import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import twilio from 'twilio';
import { DataSource, type QueryRunner } from 'typeorm';
import {
  decryptDelivery,
  parseEncryptionKey,
  type DeliveryPayload,
} from '../utils/auth-security.js';
import type { OtpChannel } from '../models/auth.types.js';

interface DeliveryRow {
  id: string;
  channel: OtpChannel;
  purpose: 'login';
  delivery_ciphertext: string | null;
  delivery_nonce: string | null;
  delivery_tag: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  superseded_at: Date | null;
  email: string;
  phone_e164: string;
}

@Injectable()
export class OtpDeliveryService {
  private readonly key: Buffer;
  private readonly testMode: boolean;
  private readonly testMessages: Array<DeliveryPayload & { channel: OtpChannel }> = [];
  private smtp?: Transporter;

  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {
    const encoded = this.config.get<string>('OTP_ENCRYPTION_KEY');
    if (!encoded) throw new Error('OTP_ENCRYPTION_KEY is required');
    this.key = parseEncryptionKey(encoded);
    const mode = this.config.get<string>('OTP_DELIVERY_MODE') ?? 'provider';
    if (mode !== 'provider' && mode !== 'test') {
      throw new Error('OTP_DELIVERY_MODE must be provider or test');
    }
    if (mode === 'test' && this.config.get<string>('NODE_ENV') !== 'test') {
      throw new Error('OTP_DELIVERY_MODE=test is restricted to NODE_ENV=test');
    }
    this.testMode = mode === 'test';
  }

  /** Test-only inbox; it is never exposed through HTTP or logs. */
  readTestMessage(destination: string): string | undefined {
    if (!this.testMode) throw new Error('Test inbox is unavailable');
    return this.testMessages.findLast((message) => message.destination === destination)?.code;
  }

  async deliverChallenge(challengeId: string, transaction?: QueryRunner): Promise<void> {
    // The queue consumer already owns a transaction and its advisory lock.
    // Reuse that connection instead of opening a second pool connection.
    if (transaction) return this.deliverLocked(transaction, challengeId);
    const runner = this.db.createQueryRunner();
    let transactionStarted = false;
    try {
      await runner.connect();
      await runner.startTransaction();
      transactionStarted = true;
      await this.deliverLocked(runner, challengeId);
      await runner.commitTransaction();
    } catch (error) {
      if (transactionStarted || runner.isTransactionActive) {
        await runner.rollbackTransaction().catch(() => undefined);
      }
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async deliverLocked(runner: QueryRunner, challengeId: string): Promise<void> {
    const rows = (await runner.query(
      `SELECT c.*, u.email, u.phone_e164
       FROM otp_challenges c JOIN users u ON u.id = c.user_id
       WHERE c.id = $1 FOR UPDATE OF c`,
      [challengeId],
    )) as DeliveryRow[];
    const challenge = rows[0];
    if (!challenge) return;
    const stale =
      challenge.consumed_at !== null ||
      challenge.superseded_at !== null ||
      new Date(challenge.expires_at).getTime() <= Date.now();
    if (stale) {
      await runner.query(
        `UPDATE otp_challenges
         SET delivery_ciphertext = NULL, delivery_nonce = NULL, delivery_tag = NULL
         WHERE id = $1`,
        [challengeId],
      );
      return;
    }
    if (
      !challenge.delivery_ciphertext ||
      !challenge.delivery_nonce ||
      !challenge.delivery_tag
    ) return;
    const payload = decryptDelivery(this.key, {
      ciphertext: challenge.delivery_ciphertext,
      nonce: challenge.delivery_nonce,
      tag: challenge.delivery_tag,
    });
    const destination = challenge.channel === 'email' ? challenge.email : challenge.phone_e164;
    if (payload.destination !== destination) {
      throw new Error('OTP destination no longer matches the user');
    }
    if (this.testMode) {
      this.testMessages.push({ ...payload, channel: challenge.channel });
    } else if (challenge.channel === 'email') {
      await this.sendEmail(payload);
    } else {
      await this.sendSms(payload);
    }
    await runner.query(
      `UPDATE otp_challenges
         SET delivery_ciphertext = NULL, delivery_nonce = NULL, delivery_tag = NULL
         WHERE id = $1`,
      [challengeId],
    );
  }

  private async sendEmail(payload: DeliveryPayload): Promise<void> {
    if (!this.smtp) {
      const host = this.config.get<string>('SMTP_HOST');
      const from = this.config.get<string>('SMTP_FROM');
      const port = Number(this.config.get<string>('SMTP_PORT') ?? 587);
      const user = this.config.get<string>('SMTP_USER');
      const pass = this.config.get<string>('SMTP_PASSWORD');
      if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('SMTP delivery is not configured');
      }
      this.smtp = nodemailer.createTransport({
        host,
        port,
        secure: this.config.get<string>('SMTP_SECURE') === 'true',
        auth: user && pass ? { user, pass } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
      });
    }
    const from = this.config.get<string>('SMTP_FROM')!;
    const info = await this.smtp.sendMail({
      from,
      to: payload.destination,
      subject: 'Your login code',
      text: `Your verification code is ${payload.code}. It expires in five minutes.`,
    });
    if (!info.accepted?.includes(payload.destination)) {
      throw new Error('SMTP did not accept the OTP recipient');
    }
  }

  private async sendSms(payload: DeliveryPayload): Promise<void> {
    const accountSid = this.config.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.config.get<string>('TWILIO_AUTH_TOKEN');
    const from = this.config.get<string>('TWILIO_FROM_NUMBER');
    if (!accountSid || !authToken || !from) {
      throw new Error('Twilio delivery is not configured');
    }
    const client = twilio(accountSid, authToken, { timeout: 10_000 });
    await client.messages.create({
      from,
      to: payload.destination,
      body: `Log in: ${payload.code}. Expires in 5 minutes.`,
    });
  }
}
