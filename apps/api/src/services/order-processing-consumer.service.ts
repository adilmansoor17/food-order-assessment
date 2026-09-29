import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import {
  BrokerService,
  DEAD_EXCHANGE,
  ORDER_DEAD_ROUTING_KEY,
  ORDER_MAIN_QUEUE,
  ORDER_RETRY_ROUTING_KEY,
  RETRY_EXCHANGE,
} from './broker.service.js';
import { DemoPaymentProductionError, FULFILLMENT_MAX_ATTEMPTS, FulfillmentMissingRecordError, FulfillmentService, FulfillmentSnapshotError } from './fulfillment.service.js';
import { safeErrorKind } from '../utils/safe-error.js';
import { waitForBrokerConfirms } from '../utils/broker-confirm.js';

type FailureDecision = Awaited<ReturnType<FulfillmentService['recordFailure']>>;

interface ProcessEvent {
  eventId: string;
  eventType: 'order.process';
  aggregateId: string;
  payload: { orderId: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseEvent(message: ConsumeMessage): ProcessEvent {
  if (message.content.length > 64 * 1024) throw new Error('INVALID_ENVELOPE');
  let value: unknown;
  try { value = JSON.parse(message.content.toString('utf8')); } catch { throw new Error('INVALID_ENVELOPE'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('INVALID_ENVELOPE');
  const event = value as Record<string, unknown>;
  const payload = event.payload;
  if (
    event.eventType !== 'order.process' ||
    typeof event.eventId !== 'string' || !UUID.test(event.eventId) ||
    typeof event.aggregateId !== 'string' || !UUID.test(event.aggregateId) ||
    typeof payload !== 'object' || payload === null || Array.isArray(payload) ||
    (payload as Record<string, unknown>).orderId !== event.aggregateId
  ) throw new Error('INVALID_ENVELOPE');
  return event as unknown as ProcessEvent;
}

@Injectable()
export class OrderProcessingConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderProcessingConsumerService.name);
  private channel: ConfirmChannel | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private connecting = false;

  constructor(private readonly broker: BrokerService, private readonly fulfillment: FulfillmentService) {}

  get connected(): boolean {
    return this.channel !== null;
  }

  onModuleInit(): void {
    this.retryTimer = setInterval(() => { void this.connect().catch((error: unknown) => this.logger.error(`Order consumer connection failed: ${safeErrorKind(error)}`)); }, 5000);
    this.retryTimer.unref();
    void this.connect().catch((error: unknown) => this.logger.error(`Order consumer connection failed: ${safeErrorKind(error)}`));
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
      channel.on('error', (error) => this.logger.error(`Order consumer channel error: ${safeErrorKind(error)}`));
      await channel.prefetch(4);
      await channel.consume(ORDER_MAIN_QUEUE, (message) => {
        if (!message) {
          void this.resetConsumerChannel(channel);
          return;
        }
        void this.handle(channel, message).catch((error: unknown) => {
          this.logger.error(`Order consumer could not acknowledge message; broker will redeliver it: ${safeErrorKind(error)}`);
        });
      }, { noAck: false });
      this.channel = channel;
    } finally {
      this.connecting = false;
    }
  }

  private async handle(channel: ConfirmChannel, message: ConsumeMessage): Promise<void> {
    let event: ProcessEvent;
    try {
      event = parseEvent(message);
    } catch {
      await this.publishOrRequeue(channel, message, true, 1, 'INVALID_ENVELOPE');
      return;
    }
    const rawAttempts = message.properties.headers?.attempts;
    const attempts = typeof rawAttempts === 'number' && Number.isInteger(rawAttempts) && rawAttempts >= 0
      ? Math.min(rawAttempts, FULFILLMENT_MAX_ATTEMPTS - 1) : 0;
    let outcome: Awaited<ReturnType<FulfillmentService['process']>>;
    try {
      outcome = await this.fulfillment.process(event.eventId, event.aggregateId);
    } catch (error) {
      if (error instanceof DemoPaymentProductionError) {
        this.logger.error(`Simulated payment order ${event.aggregateId} reached a production worker; dead-lettering without settlement`);
        await this.publishOrRequeue(channel, message, true, attempts + 1, 'DEMO_PAYMENT_PRODUCTION');
        return;
      }
      if (error instanceof FulfillmentMissingRecordError) {
        this.logger.warn(`Order event ${event.eventId} has no durable fulfillment record; dead-lettering`);
        await this.publishOrRequeue(channel, message, true, attempts + 1, 'FULFILLMENT_RECORD_MISSING');
        return;
      }
      const reason = error instanceof FulfillmentSnapshotError ? 'INVALID_SNAPSHOT' : 'PROCESSING_ERROR';
      this.logger.error(`Order processing failed for ${event.aggregateId} on attempt ${attempts + 1}: ${safeErrorKind(error)}`);
      let decision: FailureDecision;
      try {
        decision = await this.fulfillment.recordFailure(event.aggregateId, reason, attempts + 1);
      } catch (recordError) {
        if (recordError instanceof FulfillmentMissingRecordError) {
          this.logger.warn(`Order event ${event.eventId} lost its durable fulfillment record; dead-lettering`);
          await this.publishOrRequeue(channel, message, true, attempts + 1, 'FULFILLMENT_RECORD_MISSING');
          return;
        }
        this.logger.error(`Could not persist order failure for ${event.aggregateId}; reconnecting consumer: ${safeErrorKind(recordError)}`);
        await this.resetConsumerChannel(channel);
        return;
      }
      if (decision.status === 'ready' || decision.status === 'cancelled') {
        channel.ack(message);
        return;
      }
      await this.publishOrRequeue(
        channel,
        message,
        decision.exhausted || attempts + 1 >= FULFILLMENT_MAX_ATTEMPTS,
        attempts + 1,
        reason,
      );
      return;
    }
    // A broker failure after persisting the final attempt can redeliver the
    // original message. Publish the dead letter again before acknowledging it.
    if (outcome === 'failed') {
      await this.publishOrRequeue(channel, message, true, FULFILLMENT_MAX_ATTEMPTS, 'PROCESSING_ERROR');
      return;
    }
    channel.ack(message);
  }

  private async publishOrRequeue(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    dead: boolean,
    attempts: number,
    reason: string,
  ): Promise<void> {
    try {
      const publisher = await this.broker.channel();
      publisher.publish(dead ? DEAD_EXCHANGE : RETRY_EXCHANGE, dead ? ORDER_DEAD_ROUTING_KEY : ORDER_RETRY_ROUTING_KEY, message.content, {
        persistent: true,
        contentType: 'application/json',
        messageId: message.properties.messageId,
        type: 'order.process',
        headers: { attempts, reason },
        ...(dead ? {} : { expiration: String(Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 10))) }),
      });
      await waitForBrokerConfirms(publisher);
      channel.ack(message);
    } catch (error) {
      this.logger.error(`Could not persist order retry/dead letter; reconnecting consumer: ${safeErrorKind(error)}`);
      await this.resetConsumerChannel(channel);
    }
  }

  private async resetConsumerChannel(channel: ConfirmChannel): Promise<void> {
    if (this.channel === channel) this.channel = null;
    // Closing the channel requeues unacked deliveries. The connection timer
    // then retries after five seconds instead of hot-looping on a poison event.
    await channel.close().catch(() => undefined);
  }
}
