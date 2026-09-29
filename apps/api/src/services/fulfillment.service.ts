import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';

type FulfillmentStatus = 'queued' | 'ready' | 'failed' | 'cancelled';
export const FULFILLMENT_MAX_ATTEMPTS = 6;

interface FulfillmentOrderRow {
  id: string;
  status: 'pending' | 'paid' | 'cancelled';
  payment_type: 'cod' | 'bank_transfer' | 'demo';
  fulfillment_status: FulfillmentStatus;
  total_minor: string;
}

interface FulfillmentTaskRow {
  order_id: string;
  status: FulfillmentStatus;
  snapshot: unknown;
  attempts: number;
}

interface OrderItemRow {
  id: string;
  product_id: string;
  variant_id: string;
  product_name: string;
  variant_name: string;
  quantity: number;
  unit_price_minor: string;
  line_total_minor: string;
}

interface SnapshotItem {
  id: string;
  productId: string;
  variantId: string;
  productName: string;
  variantName: string;
  quantity: number;
  unitPriceMinor: string;
  lineTotalMinor: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class FulfillmentSnapshotError extends Error {
  constructor() { super('Fulfillment snapshot is invalid'); }
}

export class FulfillmentMissingRecordError extends Error {
  constructor() { super('Fulfillment order or task is missing'); }
}

export class DemoPaymentProductionError extends Error {
  constructor() { super('Simulated payments cannot be settled in production'); }
}

function minor(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new FulfillmentSnapshotError();
  return BigInt(value);
}

function snapshotItems(value: unknown, orderId: string, totalMinor: string): SnapshotItem[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new FulfillmentSnapshotError();
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.orderId !== orderId || minor(record.totalMinor) !== minor(totalMinor)) {
    throw new FulfillmentSnapshotError();
  }
  if (!Array.isArray(record.items) || record.items.length < 1) {
    throw new FulfillmentSnapshotError();
  }
  let total = 0n;
  const items: SnapshotItem[] = [];
  const ids = new Set<string>();
  for (const raw of record.items) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new FulfillmentSnapshotError();
    const item = raw as Record<string, unknown>;
    if (
      typeof item.id !== 'string' || !UUID.test(item.id) || ids.has(item.id) ||
      typeof item.productId !== 'string' || !UUID.test(item.productId) ||
      typeof item.variantId !== 'string' || !UUID.test(item.variantId) ||
      typeof item.productName !== 'string' || !item.productName ||
      typeof item.variantName !== 'string' || !item.variantName ||
      typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99
    ) throw new FulfillmentSnapshotError();
    ids.add(item.id);
    const price = minor(item.unitPriceMinor);
    const line = minor(item.lineTotalMinor);
    if (price * BigInt(item.quantity) !== line) throw new FulfillmentSnapshotError();
    total += line;
    items.push(item as unknown as SnapshotItem);
  }
  if (total !== minor(totalMinor)) throw new FulfillmentSnapshotError();
  return items;
}

@Injectable()
export class FulfillmentService {
  constructor(private readonly database: DataSource) {}

  async process(eventId: string, orderId: string): Promise<'ready' | 'already_ready' | 'cancelled' | 'failed'> {
    if (!UUID.test(eventId) || !UUID.test(orderId)) throw new FulfillmentSnapshotError();
    return this.transaction(async (runner) => {
      const orders = await runner.query('SELECT id, status, payment_type, fulfillment_status, total_minor FROM orders WHERE id = $1 FOR UPDATE', [orderId]) as FulfillmentOrderRow[];
      if (!orders.length) throw new FulfillmentMissingRecordError();
      const order = orders[0];
      const tasks = await runner.query('SELECT order_id, status, snapshot, attempts FROM order_fulfillment_tasks WHERE order_id = $1 FOR UPDATE', [orderId]) as FulfillmentTaskRow[];
      if (!tasks.length) throw new FulfillmentMissingRecordError();
      const task = tasks[0];
      if (order.payment_type === 'demo' && process.env.NODE_ENV === 'production') {
        throw new DemoPaymentProductionError();
      }
      if (order.status === 'cancelled' || order.fulfillment_status === 'cancelled' || task.status === 'cancelled') {
        await this.dedupe(runner, eventId);
        return 'cancelled';
      }
      if (order.fulfillment_status === 'failed' || task.status === 'failed') {
        await this.dedupe(runner, eventId);
        return 'failed';
      }
      if (task.status === 'ready') {
        if (order.payment_type === 'demo' && order.status !== 'paid') throw new FulfillmentSnapshotError();
        if (order.fulfillment_status !== 'ready') {
          await runner.query(
            "UPDATE orders SET fulfillment_status = 'ready', fulfillment_updated_at = now(), updated_at = now() WHERE id = $1",
            [orderId],
          );
        }
        await this.dedupe(runner, eventId);
        return 'already_ready';
      }

      const snapshot = snapshotItems(task.snapshot, orderId, order.total_minor);
      const persisted = await runner.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]) as OrderItemRow[];
      if (persisted.length !== snapshot.length) throw new FulfillmentSnapshotError();
      const persistedById = new Map(persisted.map((item) => [item.id, item]));
      for (const item of snapshot) {
        const matching = persistedById.get(item.id);
        if (!matching || matching.product_id !== item.productId || matching.variant_id !== item.variantId ||
            matching.product_name !== item.productName || matching.variant_name !== item.variantName ||
            matching.quantity !== item.quantity || matching.unit_price_minor !== item.unitPriceMinor ||
            matching.line_total_minor !== item.lineTotalMinor) throw new FulfillmentSnapshotError();
      }
      await runner.query(
        "UPDATE order_fulfillment_tasks SET status = 'ready', processed_at = now(), updated_at = now(), last_error = NULL WHERE order_id = $1",
        [orderId],
      );
      if (order.payment_type === 'demo') {
        if (order.status !== 'pending') throw new FulfillmentSnapshotError();
        const payments = await runner.query(
          `UPDATE simulated_payments
              SET status = 'succeeded', settled_at = now(), updated_at = now()
            WHERE order_id = $1 AND amount_minor = $2 AND currency = 'PKR' AND status = 'pending'
            RETURNING id`,
          [orderId, order.total_minor],
        ) as [{ id: string }[], number];
        if (payments[1] !== 1) throw new FulfillmentSnapshotError();
        await runner.query(
          "UPDATE orders SET status = 'paid', paid_at = now(), fulfillment_status = 'ready', fulfillment_updated_at = now(), updated_at = now() WHERE id = $1",
          [orderId],
        );
        await runner.query(
          "INSERT INTO outbox (id, event_type, aggregate_id, payload) VALUES ($1, 'order.paid', $2, $3::jsonb)",
          [randomUUID(), orderId, JSON.stringify({ orderId })],
        );
      } else {
        await runner.query(
          "UPDATE orders SET fulfillment_status = 'ready', fulfillment_updated_at = now(), updated_at = now() WHERE id = $1",
          [orderId],
        );
      }
      await this.dedupe(runner, eventId);
      return 'ready';
    });
  }

  async recordFailure(orderId: string, reason: string, attemptNumber: number): Promise<{
    status: FulfillmentStatus;
    attempts: number;
    exhausted: boolean;
  }> {
    if (!UUID.test(orderId) || !Number.isInteger(attemptNumber) || attemptNumber < 1) throw new Error('Invalid fulfillment attempt');
    return this.transaction(async (runner) => {
      const orders = await runner.query('SELECT status, fulfillment_status FROM orders WHERE id = $1 FOR UPDATE', [orderId]) as Pick<FulfillmentOrderRow, 'status' | 'fulfillment_status'>[];
      if (!orders.length) throw new FulfillmentMissingRecordError();
      const tasks = await runner.query('SELECT status, attempts FROM order_fulfillment_tasks WHERE order_id = $1 FOR UPDATE', [orderId]) as Pick<FulfillmentTaskRow, 'status' | 'attempts'>[];
      if (!tasks.length) throw new FulfillmentMissingRecordError();
      const task = tasks[0];
      if (orders[0].status === 'cancelled' || task.status === 'cancelled') {
        return { status: 'cancelled', attempts: task.attempts, exhausted: false };
      }
      if (task.status === 'ready') return { status: 'ready', attempts: task.attempts, exhausted: false };
      if (task.status === 'failed') return { status: 'failed', attempts: task.attempts, exhausted: true };
      const attempts = Math.min(FULFILLMENT_MAX_ATTEMPTS, Math.max(task.attempts, attemptNumber));
      const exhausted = attempts >= FULFILLMENT_MAX_ATTEMPTS;
      const safeReason = /^[A-Z_]{1,80}$/.test(reason) ? reason : 'PROCESSING_ERROR';
      if (exhausted) {
        await runner.query(
          `UPDATE order_fulfillment_tasks SET status = 'failed', attempts = $2, last_error = $3,
             failed_at = now(), updated_at = now() WHERE order_id = $1`,
          [orderId, attempts, safeReason],
        );
        await runner.query(
          "UPDATE orders SET fulfillment_status = 'failed', fulfillment_updated_at = now(), updated_at = now() WHERE id = $1",
          [orderId],
        );
        return { status: 'failed', attempts, exhausted: true };
      }
      await runner.query(
        'UPDATE order_fulfillment_tasks SET attempts = $2, last_error = $3, updated_at = now() WHERE order_id = $1',
        [orderId, attempts, safeReason],
      );
      return { status: 'queued', attempts, exhausted: false };
    });
  }

  private async dedupe(runner: QueryRunner, eventId: string): Promise<void> {
    await runner.query(
      'INSERT INTO consumer_dedupe (event_id, consumer) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [eventId, 'fulfillment'],
    );
  }

  private async transaction<T>(operation: (runner: QueryRunner) => Promise<T>): Promise<T> {
    const runner = this.database.createQueryRunner();
    let transactionStarted = false;
    try {
      await runner.connect();
      await runner.startTransaction();
      transactionStarted = true;
      const result = await operation(runner);
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
}
