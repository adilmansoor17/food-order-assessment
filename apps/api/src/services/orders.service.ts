import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { capacityLimit } from '../config/capacity.js';
import type { AuthUser } from '../models/user.types.js';
import type { CheckoutDto } from '../models/orders.dto.js';
import type { OrderItemView, OrderView, PaymentType } from '../models/orders.types.js';

interface OrderRow {
  id: string;
  user_id: string;
  status: 'pending' | 'paid' | 'cancelled';
  fulfillment_status: 'queued' | 'ready' | 'failed' | 'cancelled';
  fulfillment_updated_at: Date | string;
  payment_type: PaymentType;
  total_minor: string;
  transfer_reference: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  paid_at: Date | string | null;
  cancelled_at: Date | string | null;
}

interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  variant_id: string;
  product_name: string;
  variant_name: string;
  quantity: number;
  unit_price_minor: string;
  line_total_minor: string;
}

interface CartLineRow {
  product_id: string;
  variant_id: string;
  product_name: string;
  variant_name: string;
  price_minor: string;
  stock: number;
  active: boolean;
  quantity: number;
}

interface CursorValue {
  createdAt: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

function ensureUuid(value: string): void {
  if (!UUID.test(value)) throw invalid('INVALID_ID', 'A valid UUID is required');
}

function money(value: string | number | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('Amount exceeds the supported PKR minor-unit range');
  }
  return result;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function listLimit(raw?: string): number {
  if (raw === undefined) return 20;
  if (!/^[1-9][0-9]*$/.test(raw)) throw invalid('INVALID_LIMIT', 'Limit must be between 1 and 100');
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result > 100) throw invalid('INVALID_LIMIT', 'Limit must be between 1 and 100');
  return result;
}

function decodeCursor(raw?: string): CursorValue | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof value === 'object' && value !== null &&
      'createdAt' in value && typeof value.createdAt === 'string' &&
      'id' in value && typeof value.id === 'string' &&
      UUID.test(value.id) && !Number.isNaN(Date.parse(value.createdAt))
    ) return { createdAt: value.createdAt, id: value.id };
  } catch { /* Invalid cursors are rejected below. */ }
  throw invalid('INVALID_CURSOR', 'Cursor is invalid');
}

function encodeCursor(order: OrderRow): string {
  return Buffer.from(JSON.stringify({ createdAt: iso(order.created_at), id: order.id })).toString('base64url');
}

function cartVersion(ifMatch?: string): number {
  if (!ifMatch) throw invalid('CART_VERSION_REQUIRED', 'If-Match cart version is required');
  const normalized = ifMatch.replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) throw invalid('INVALID_CART_VERSION', 'If-Match must be a cart version');
  const version = Number(normalized);
  if (!Number.isSafeInteger(version)) throw invalid('INVALID_CART_VERSION', 'If-Match must be a cart version');
  return version;
}

@Injectable()
export class OrdersService {
  private readonly maxCartLines = capacityLimit('CART_MAX_LINES', 100, 1000);

  constructor(private readonly database: DataSource) {}

  async isCheckoutReplay(userId: string, idempotencyKey: string | undefined): Promise<boolean> {
    if (!idempotencyKey || !UUID.test(idempotencyKey)) return false;
    const rows = await this.database.query(
      'SELECT 1 FROM checkout_requests WHERE user_id = $1 AND idempotency_key = $2',
      [userId, idempotencyKey],
    ) as Array<{ '?column?': number }>;
    return rows.length > 0;
  }

  async checkout(
    actor: AuthUser,
    idempotencyKey: string | undefined,
    ifMatch: string | undefined,
    request: CheckoutDto,
  ): Promise<OrderView> {
    if (!idempotencyKey || !UUID.test(idempotencyKey)) {
      throw invalid('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key must be a UUID');
    }
    const version = cartVersion(ifMatch);
    if (!['cod', 'bank_transfer', 'demo'].includes(request.paymentType) ||
        !Number.isSafeInteger(request.expectedTotalMinor) || request.expectedTotalMinor < 0) {
      throw invalid('INVALID_CHECKOUT', 'A payment type and expected total in PKR minor units are required');
    }
    if (request.paymentType === 'demo' &&
        (process.env.NODE_ENV === 'production' || process.env.DEMO_PAYMENTS_ENABLED !== 'true')) {
      throw invalid('DEMO_PAYMENT_UNAVAILABLE', 'Simulated payments are unavailable');
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ paymentType: request.paymentType, expectedTotalMinor: request.expectedTotalMinor, cartVersion: version }))
      .digest('hex');
    const runner = this.database.createQueryRunner();
    let transactionStarted = false;
    try {
      await runner.connect();
      await runner.startTransaction();
      transactionStarted = true;
      // A same-key retry waits for the original transaction, then reads its committed result.
      await runner.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [actor.id, idempotencyKey]);
      const existing = await runner.query(
        'SELECT request_hash, order_id FROM checkout_requests WHERE user_id = $1 AND idempotency_key = $2',
        [actor.id, idempotencyKey],
      ) as { request_hash: string; order_id: string }[];
      if (existing.length) {
        if (existing[0].request_hash !== fingerprint) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', 'This key belongs to a different checkout request');
        }
        const original = await this.loadOrder(runner, actor, existing[0].order_id, true);
        await runner.commitTransaction();
        return original;
      }

      const carts = await runner.query('SELECT id, version FROM carts WHERE user_id = $1 FOR UPDATE', [actor.id]) as { id: string; version: number }[];
      if (!carts.length) throw conflict('CART_EMPTY', 'Add an item before checkout');
      const cart = carts[0];
      if (cart.version !== version) {
        throw new PreconditionFailedException({ code: 'CART_VERSION_CONFLICT', message: 'Cart changed; refresh it before checkout' });
      }
      // Catalog archive takes product locks before variant locks. Keep the same order here.
      await runner.query(
        `SELECT p.id FROM products p
          WHERE p.id IN (
            SELECT v.product_id FROM cart_items ci
            JOIN variants v ON v.id = ci.variant_id WHERE ci.cart_id = $1
          )
          ORDER BY p.id FOR SHARE`,
        [cart.id],
      );
      const lines = await runner.query(
        `SELECT v.id AS variant_id, p.id AS product_id, p.name AS product_name,
                v.name AS variant_name, v.price_minor, v.stock,
                (v.active AND p.active AND p.archived_at IS NULL) AS active, ci.quantity
           FROM cart_items ci
           JOIN variants v ON v.id = ci.variant_id
           JOIN products p ON p.id = v.product_id
          WHERE ci.cart_id = $1
          ORDER BY v.id
          FOR UPDATE OF v`,
        [cart.id],
      ) as CartLineRow[];
      if (!lines.length) throw conflict('CART_EMPTY', 'Add an item before checkout');
      if (lines.length > this.maxCartLines) throw conflict('CART_LINE_LIMIT', 'Cart has too many distinct items');
      if (lines.some((line) => !line.active)) throw conflict('PRODUCT_UNAVAILABLE', 'A cart item is no longer available');
      let total = 0n;
      for (const line of lines) {
        if (line.quantity < 1 || line.quantity > 99) throw conflict('INVALID_QUANTITY', 'A cart quantity is invalid');
        total += BigInt(line.price_minor) * BigInt(line.quantity);
      }
      const totalMinor = money(total);
      if (totalMinor !== request.expectedTotalMinor) {
        throw conflict('PRICE_CHANGED', 'Cart prices changed; review the total before checkout');
      }
      for (const line of lines) {
        const decremented = await runner.query(
          `UPDATE variants SET stock = stock - $2, updated_at = now()
            WHERE id = $1 AND stock >= $2 AND active = true RETURNING id`,
          [line.variant_id, line.quantity],
        ) as [{ id: string }[], number];
        if (decremented[1] !== 1) throw conflict('OUT_OF_STOCK', 'A cart item is out of stock');
      }
      const orderId = randomUUID();
      const inserted = await runner.query(
        `INSERT INTO orders (id, user_id, payment_type, total_minor)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [orderId, actor.id, request.paymentType, total.toString()],
      ) as OrderRow[];
      if (request.paymentType === 'demo') {
        await runner.query(
          'INSERT INTO simulated_payments (id, order_id, amount_minor) VALUES ($1,$2,$3)',
          [randomUUID(), orderId, total.toString()],
        );
      }
      const orderItems: OrderItemRow[] = [];
      for (const line of lines) {
        const itemId = randomUUID();
        const lineTotal = BigInt(line.price_minor) * BigInt(line.quantity);
        const item = await runner.query(
          `INSERT INTO order_items
             (id, order_id, product_id, variant_id, product_name, variant_name, quantity, unit_price_minor, line_total_minor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [itemId, orderId, line.product_id, line.variant_id, line.product_name, line.variant_name,
            line.quantity, line.price_minor, lineTotal.toString()],
        ) as OrderItemRow[];
        orderItems.push(item[0]);
      }
      const fulfillmentSnapshot = {
        version: 1,
        orderId,
        totalMinor: total.toString(),
        items: orderItems.map((item) => ({
          id: item.id,
          productId: item.product_id,
          variantId: item.variant_id,
          productName: item.product_name,
          variantName: item.variant_name,
          quantity: item.quantity,
          unitPriceMinor: item.unit_price_minor,
          lineTotalMinor: item.line_total_minor,
        })),
      };
      await runner.query(
        'INSERT INTO order_fulfillment_tasks (order_id, snapshot) VALUES ($1,$2::jsonb)',
        [orderId, JSON.stringify(fulfillmentSnapshot)],
      );
      await runner.query(
        'INSERT INTO checkout_requests (user_id, idempotency_key, request_hash, order_id) VALUES ($1,$2,$3,$4)',
        [actor.id, idempotencyKey, fingerprint, orderId],
      );
      await runner.query('DELETE FROM cart_items WHERE cart_id = $1', [cart.id]);
      await runner.query('UPDATE carts SET version = version + 1, updated_at = now() WHERE id = $1', [cart.id]);
      await this.enqueue(runner, 'order.process', orderId, { orderId });
      await this.enqueue(runner, 'order.placed', orderId, { orderId });
      const response = this.toView(inserted[0], orderItems);
      await runner.commitTransaction();
      return response;
    } catch (error) {
      if (transactionStarted || runner.isTransactionActive) {
        await runner.rollbackTransaction().catch(() => undefined);
      }
      throw error;
    } finally {
      await runner.release();
    }
  }

  async get(actor: AuthUser, orderId: string): Promise<OrderView> {
    ensureUuid(orderId);
    return this.loadOrder(this.database, actor, orderId);
  }

  async status(actor: AuthUser, orderId: string) {
    ensureUuid(orderId);
    const rows = await this.database.query(
      'SELECT status, fulfillment_status, fulfillment_updated_at, updated_at FROM orders WHERE id = $1 AND (user_id = $2 OR $3 = $4)',
      [orderId, actor.id, actor.role, 'admin'],
    ) as Pick<OrderRow, 'status' | 'fulfillment_status' | 'fulfillment_updated_at' | 'updated_at'>[];
    if (!rows.length) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    return {
      status: rows[0].status,
      paymentStatus: this.paymentStatus(rows[0].status),
      fulfillmentStatus: rows[0].fulfillment_status,
      fulfillmentUpdatedAt: iso(rows[0].fulfillment_updated_at),
      updatedAt: iso(rows[0].updated_at),
    };
  }

  async list(actor: AuthUser, cursor?: string, limit?: string) {
    return this.listOrders(actor.id, cursor, limit);
  }

  async listAdmin(cursor?: string, limit?: string) {
    return this.listOrders(null, cursor, limit);
  }

  private async listOrders(userId: string | null, rawCursor?: string, rawLimit?: string) {
    const cursor = decodeCursor(rawCursor);
    const limit = listLimit(rawLimit);
    const rows = await this.database.query(userId === null
      ? `SELECT * FROM orders
          WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $3`
      : `SELECT * FROM orders
          WHERE user_id = $1
            AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $4`,
      userId === null
        ? [cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]
        : [userId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    ) as OrderRow[];
    const page = rows.slice(0, limit);
    const items = page.length ? await this.database.query(
      'SELECT * FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY variant_id',
      [page.map((row) => row.id)],
    ) as OrderItemRow[] : [];
    const grouped = new Map<string, OrderItemRow[]>();
    for (const item of items) grouped.set(item.order_id, [...(grouped.get(item.order_id) ?? []), item]);
    return {
      items: page.map((row) => this.toView(row, grouped.get(row.id) ?? [])),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  async updateTransferReference(actor: AuthUser, orderId: string, reference: string): Promise<OrderView> {
    ensureUuid(orderId);
    if (reference.length > 120 || !reference.trim()) throw invalid('INVALID_REFERENCE', 'Reference must be 1 to 120 characters');
    return this.inTransaction(async (runner) => {
      const rows = await runner.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE', [orderId, actor.id]) as OrderRow[];
      if (!rows.length) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      const order = rows[0];
      if (order.status !== 'pending') {
        throw conflict('ORDER_NOT_PENDING', 'Transfer reference cannot be changed for this order');
      }
      if (order.payment_type !== 'bank_transfer') throw conflict('PAYMENT_TYPE_MISMATCH', 'This order does not use bank transfer');
      await runner.query('UPDATE orders SET transfer_reference = $2, updated_at = now() WHERE id = $1', [orderId, reference]);
      await this.enqueue(runner, 'order.transfer_reference_updated', orderId, { orderId });
      return this.loadOrder(runner, actor, orderId);
    });
  }

  async markPaid(actor: AuthUser, orderId: string): Promise<OrderView> {
    ensureUuid(orderId);
    return this.inTransaction(async (runner) => {
      const rows = await runner.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]) as OrderRow[];
      if (!rows.length) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      const order = rows[0];
      if (order.status === 'cancelled') throw conflict('ORDER_CANCELLED', 'A cancelled order cannot be marked paid');
      if (order.status === 'pending') {
        if (order.payment_type === 'demo') {
          throw conflict('DEMO_PAYMENT_AUTOMATIC', 'Simulated payment is settled by order processing');
        }
        if (order.fulfillment_status !== 'ready') {
          throw conflict('FULFILLMENT_NOT_READY', 'Fulfillment must be ready before payment can be recorded');
        }
        if (order.payment_type === 'bank_transfer' && !order.transfer_reference) {
          throw conflict('TRANSFER_REFERENCE_REQUIRED', 'Customer transfer reference is required before verification');
        }
        await runner.query('UPDATE orders SET status = $2, paid_at = now(), updated_at = now() WHERE id = $1', [orderId, 'paid']);
        await runner.query(
          'INSERT INTO admin_audit (id, actor_id, action, target_id, metadata) VALUES ($1,$2,$3,$4,$5::jsonb)',
          [randomUUID(), actor.id, 'order.mark_paid', orderId, JSON.stringify({ paymentType: order.payment_type })],
        );
        await this.enqueue(runner, 'order.paid', orderId, { orderId });
      }
      return this.loadOrder(runner, actor, orderId);
    });
  }

  async cancel(actor: AuthUser, orderId: string): Promise<OrderView> {
    ensureUuid(orderId);
    return this.inTransaction(async (runner) => {
      const rows = await runner.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]) as OrderRow[];
      if (!rows.length) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      const order = rows[0];
      if (order.status === 'paid') {
        throw conflict('PAID_ORDER_CANCELLATION_REQUIRES_REFUND', 'A paid order requires a refund process before cancellation');
      }
      if (order.status === 'pending') {
        if (order.payment_type === 'demo') {
          const voided = await runner.query(
            `UPDATE simulated_payments SET status = 'cancelled', cancelled_at = now(), updated_at = now()
              WHERE order_id = $1 AND status = 'pending' RETURNING id`,
            [orderId],
          ) as [{ id: string }[], number];
          if (voided[1] !== 1) throw new Error('Simulated payment is missing or already settled');
        }
        const items = await runner.query('SELECT variant_id, quantity FROM order_items WHERE order_id = $1 ORDER BY variant_id', [orderId]) as { variant_id: string; quantity: number }[];
        for (const item of items) {
          await runner.query('UPDATE variants SET stock = stock + $2, updated_at = now() WHERE id = $1', [item.variant_id, item.quantity]);
        }
        await runner.query(
          `UPDATE order_fulfillment_tasks SET status = 'cancelled', voided_at = now(), updated_at = now()
            WHERE order_id = $1 AND status <> 'cancelled'`,
          [orderId],
        );
        await runner.query(
          `UPDATE orders SET status = 'cancelled', fulfillment_status = 'cancelled',
             fulfillment_updated_at = now(), cancelled_at = now(), updated_at = now() WHERE id = $1`,
          [orderId],
        );
        await runner.query(
          'INSERT INTO admin_audit (id, actor_id, action, target_id, metadata) VALUES ($1,$2,$3,$4,$5::jsonb)',
          [randomUUID(), actor.id, 'order.cancel', orderId, '{}'],
        );
        await this.enqueue(runner, 'order.cancelled', orderId, { orderId });
      }
      return this.loadOrder(runner, actor, orderId);
    });
  }

  private async inTransaction<T>(operation: (runner: QueryRunner) => Promise<T>): Promise<T> {
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

  private async enqueue(runner: QueryRunner, eventType: string, aggregateId: string, payload: object): Promise<void> {
    await runner.query(
      'INSERT INTO outbox (id, event_type, aggregate_id, payload) VALUES ($1,$2,$3,$4::jsonb)',
      [randomUUID(), eventType, aggregateId, JSON.stringify(payload)],
    );
  }

  private async loadOrder(
    client: Pick<DataSource, 'query'> | Pick<QueryRunner, 'query'>,
    actor: AuthUser,
    orderId: string,
    originalResponse = false,
  ): Promise<OrderView> {
    const rows = await client.query(
      'SELECT * FROM orders WHERE id = $1 AND (user_id = $2 OR $3 = $4)',
      [orderId, actor.id, actor.role, 'admin'],
    ) as OrderRow[];
    if (!rows.length) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    const items = await client.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY variant_id', [orderId]) as OrderItemRow[];
    const view = this.toView(rows[0], items);
    if (originalResponse) {
      view.status = 'pending';
      view.paymentStatus = 'pending';
      view.fulfillmentStatus = 'queued';
      view.fulfillmentUpdatedAt = view.createdAt;
      view.transferReference = null;
      view.updatedAt = view.createdAt;
      view.paidAt = null;
      view.cancelledAt = null;
    }
    return view;
  }

  private toView(row: OrderRow, rows: OrderItemRow[]): OrderView {
    const items: OrderItemView[] = rows.map((item) => ({
      id: item.id,
      productId: item.product_id,
      variantId: item.variant_id,
      productName: item.product_name,
      variantName: item.variant_name,
      quantity: item.quantity,
      unitPriceMinor: money(item.unit_price_minor),
      lineTotalMinor: money(item.line_total_minor),
    }));
    return {
      id: row.id,
      status: row.status,
      paymentType: row.payment_type,
      paymentStatus: this.paymentStatus(row.status),
      fulfillmentStatus: row.fulfillment_status,
      fulfillmentUpdatedAt: iso(row.fulfillment_updated_at)!,
      totalMinor: money(row.total_minor),
      currency: 'PKR',
      transferReference: row.transfer_reference,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
      paidAt: iso(row.paid_at),
      cancelledAt: iso(row.cancelled_at),
      items,
    };
  }

  private paymentStatus(status: OrderRow['status']): OrderView['paymentStatus'] {
    return status === 'paid' ? 'paid' : 'pending';
  }
}
