import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { DataSource } from 'typeorm';
import { OtpDeliveryService } from './otp-delivery.service.js';
import {
  BrokerService,
  DEAD_EXCHANGE,
  MAIN_QUEUE,
  RETRY_EXCHANGE,
} from './broker.service.js';
import { OrderEmailService } from './order-email.service.js';
import { safeErrorKind } from '../utils/safe-error.js';
import { waitForBrokerConfirms } from '../utils/broker-confirm.js';

interface EventEnvelope {
  eventId: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const MAX_DELIVERY_ATTEMPTS = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTIFICATION_EVENTS = new Set([
  'otp.send', 'order.placed', 'order.paid', 'order.cancelled', 'order.transfer_reference_updated',
]);

class PermanentNotificationError extends Error {
  constructor() { super('Notification event cannot be processed'); }
}

function envelope(message: ConsumeMessage): EventEnvelope {
  if (message.content.length > 64 * 1024) throw new PermanentNotificationError();
  let value: unknown;
  try { value = JSON.parse(message.content.toString('utf8')); } catch { throw new PermanentNotificationError(); }
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    !('eventId' in value) || typeof value.eventId !== 'string' || !UUID.test(value.eventId) ||
    !('eventType' in value) || typeof value.eventType !== 'string' || !NOTIFICATION_EVENTS.has(value.eventType) ||
    !('aggregateId' in value) || typeof value.aggregateId !== 'string' || !UUID.test(value.aggregateId) ||
    !('payload' in value) || typeof value.payload !== 'object' || value.payload === null || Array.isArray(value.payload) ||
    !('createdAt' in value) || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))
  ) throw new PermanentNotificationError();
  const payload = value.payload as Record<string, unknown>;
  if (value.eventType === 'otp.send'
    ? typeof payload.challengeId !== 'string' || !UUID.test(payload.challengeId) || payload.challengeId !== value.aggregateId
    : typeof payload.orderId !== 'string' || payload.orderId !== value.aggregateId) {
    throw new PermanentNotificationError();
  }
  return value as EventEnvelope;
}

@Injectable()
export class NotificationConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationConsumerService.name);
  private channel: ConfirmChannel | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private connecting = false;

  constructor(
    private readonly database: DataSource,
    private readonly broker: BrokerService,
    private readonly otpDelivery: OtpDeliveryService,
    private readonly orderEmail: OrderEmailService,
  ) {}

  get connected(): boolean {
    return this.channel !== null;
  }

  onModuleInit(): void {
    this.retryTimer = setInterval(() => { void this.connect().catch((error: unknown) => this.logger.error(`Queue consumer connection failed: ${safeErrorKind(error)}`)); }, 5000);
    this.retryTimer.unref();
    void this.connect().catch((error: unknown) => this.logger.error(`Queue consumer connection failed: ${safeErrorKind(error)}`));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.channel) await this.channel.close().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.channel || this.connecting) return;
    this.connecting = true;
    try {
      const channel = await this.broker.consumerChannel();
      channel.on('close', () => { if (this.channel === channel) this.channel = null; });
      channel.on('error', (error) => this.logger.error(`Queue consumer channel error: ${safeErrorKind(error)}`));
      await channel.prefetch(4);
      await channel.consume(MAIN_QUEUE, (message) => {
        if (!message) {
          void this.resetConsumerChannel(channel);
          return;
        }
        void this.handle(channel, message).catch((error: unknown) => {
          this.logger.error(`Notification consumer could not acknowledge message; broker will redeliver it: ${safeErrorKind(error)}`);
        });
      }, { noAck: false });
      this.channel = channel;
    } finally {
      this.connecting = false;
    }
  }

  private async handle(channel: ConfirmChannel, message: ConsumeMessage): Promise<void> {
    const rawAttempts = message.properties.headers?.attempts;
    const attempts = typeof rawAttempts === 'number' && Number.isInteger(rawAttempts) && rawAttempts >= 0
      ? Math.min(rawAttempts, MAX_DELIVERY_ATTEMPTS - 1) : 0;
    try {
      const event = envelope(message);
      await this.deliver(event);
    } catch (error) {
      const eventId = typeof message.properties.messageId === 'string' && UUID.test(message.properties.messageId)
        ? message.properties.messageId : 'unknown';
      const eventType = typeof message.properties.type === 'string' && NOTIFICATION_EVENTS.has(message.properties.type)
        ? message.properties.type : 'invalid';
      this.logger.error(`Queue event ${eventId} failed on attempt ${attempts + 1}: ${safeErrorKind(error)}`);
      try {
        const publisher = await this.broker.channel();
        // Immutable malformed payloads will not improve after a delay. Provider/database errors may.
        const dead = error instanceof PermanentNotificationError || attempts + 1 >= MAX_DELIVERY_ATTEMPTS;
        publisher.publish(dead ? DEAD_EXCHANGE : RETRY_EXCHANGE, dead ? 'notifications.dead' : 'notifications.retry', message.content, {
          persistent: true,
          contentType: 'application/json',
          ...(eventId === 'unknown' ? {} : { messageId: eventId }),
          type: eventType,
          headers: { attempts: attempts + 1, reason: error instanceof PermanentNotificationError ? 'INVALID_EVENT' : 'DELIVERY_ERROR' },
          ...(dead ? {} : { expiration: String(Math.min(30_000, 1000 * 2 ** attempts)) }),
        });
        await waitForBrokerConfirms(publisher);
      } catch (retryError) {
        this.logger.error(`Failed to persist notification retry; reconnecting consumer: ${safeErrorKind(retryError)}`);
        await this.resetConsumerChannel(channel);
        return;
      }
      channel.ack(message);
      return;
    }
    channel.ack(message);
  }

  private async resetConsumerChannel(channel: ConfirmChannel): Promise<void> {
    if (this.channel === channel) this.channel = null;
    // Closing requeues unacked deliveries after the five-second reconnect,
    // instead of repeatedly nacking a message against an unavailable broker.
    await channel.close().catch(() => undefined);
  }

  private async deliver(event: EventEnvelope): Promise<void> {
    const runner = this.database.createQueryRunner();
    let transactionStarted = false;
    try {
      await runner.connect();
      await runner.startTransaction();
      transactionStarted = true;
      await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [event.eventId]);
      const alreadyHandled = await runner.query(
        'SELECT 1 FROM consumer_dedupe WHERE event_id = $1 AND consumer = $2',
        [event.eventId, 'notifications'],
      ) as { '?column?': number }[];
      if (!alreadyHandled.length) {
        if (event.eventType === 'otp.send') {
          const challengeId = event.payload.challengeId;
          if (typeof challengeId !== 'string' || !UUID.test(challengeId)) throw new PermanentNotificationError();
          await this.otpDelivery.deliverChallenge(challengeId, runner);
        } else if (event.eventType.startsWith('order.')) {
          const orderId = event.payload.orderId;
          if (typeof orderId !== 'string' || orderId !== event.aggregateId) throw new PermanentNotificationError();
          await this.orderEmail.send(runner, event.eventId, event.eventType, orderId);
        } else {
          throw new PermanentNotificationError();
        }
        await runner.query(
          'INSERT INTO consumer_dedupe (event_id, consumer) VALUES ($1,$2)',
          [event.eventId, 'notifications'],
        );
      }
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
}
