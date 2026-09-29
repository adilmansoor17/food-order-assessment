import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BrokerService, EVENTS_EXCHANGE, ORDER_ROUTING_KEY } from './broker.service.js';
import { safeErrorKind } from '../utils/safe-error.js';
import { waitForBrokerConfirms } from '../utils/broker-confirm.js';

interface OutboxRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date | string;
}

const BATCH_SIZE = 100;
const IDLE_DELAY_MS = 1000;
const MAX_ERROR_DELAY_MS = 30_000;

@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private runTask: Promise<void> | null = null;
  private stopped = true;
  private working = false;

  constructor(private readonly database: DataSource, private readonly broker: BrokerService) {}

  onModuleInit(): void {
    if (this.runTask) return;
    this.stopped = false;
    this.runTask = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    await this.runTask;
    this.runTask = null;
  }

  private async run(): Promise<void> {
    let consecutiveErrors = 0;
    while (!this.stopped) {
      let delay = IDLE_DELAY_MS;
      try {
        const count = await this.dispatch();
        consecutiveErrors = 0;
        // A full batch indicates more due events may be waiting. Yield to the
        // event loop, then drain the next bounded batch without a one-second cap.
        if (count === BATCH_SIZE) delay = 0;
      } catch (error) {
        this.logger.error(`Outbox dispatch failed: ${safeErrorKind(error)}`);
        consecutiveErrors = Math.min(consecutiveErrors + 1, 6);
        delay = Math.min(MAX_ERROR_DELAY_MS, IDLE_DELAY_MS * 2 ** (consecutiveErrors - 1));
      }
      if (!this.stopped) await this.sleep(delay);
    }
  }

  private sleep(delay: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        this.timer = null;
        this.wake = null;
        resolve();
      };
      this.wake = wake;
      this.timer = setTimeout(wake, delay);
      this.timer.unref();
    });
  }

  async dispatch(): Promise<number> {
    if (this.working) return 0;
    this.working = true;
    const runner = this.database.createQueryRunner();
    try {
      // Broker setup can be slow during recovery; acquire it before holding
      // database row locks or a transaction connection.
      const channel = await this.broker.channel();
      await runner.connect();
      await runner.startTransaction();
      const events = await runner.query(
        `SELECT id, event_type, aggregate_id, payload, attempts, created_at
           FROM outbox
          WHERE status = 'pending' AND available_at <= now()
          ORDER BY available_at, created_at, id
          LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED`,
      ) as OutboxRow[];
      if (!events.length) {
        await runner.commitTransaction();
        return 0;
      }
      for (const event of events) {
        const message = Buffer.from(JSON.stringify({
          eventId: event.id,
          eventType: event.event_type,
          aggregateId: event.aggregate_id,
          payload: event.payload,
          createdAt: new Date(event.created_at).toISOString(),
        }));
        channel.publish(EVENTS_EXCHANGE, event.event_type === 'order.process' ? ORDER_ROUTING_KEY : 'notifications', message, {
          persistent: true,
          contentType: 'application/json',
          messageId: event.id,
          type: event.event_type,
        });
      }
      // Confirm before marking sent. A crash between confirm and commit can replay; consumers dedupe by event ID.
      await waitForBrokerConfirms(channel);
      await runner.query('UPDATE outbox SET status = $2, sent_at = now() WHERE id = ANY($1::uuid[])', [events.map((event) => event.id), 'sent']);
      await runner.commitTransaction();
      return events.length;
    } catch (error) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction().catch(() => undefined);
      }
      await this.broker.reset();
      // No event is removed when the broker is down; the next worker pass retries it.
      throw error;
    } finally {
      await runner.release();
      this.working = false;
    }
  }
}
