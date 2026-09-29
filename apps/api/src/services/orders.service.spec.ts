import { createHash, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { AuthUser } from '../models/user.types.js';
import { OrdersService } from './orders.service.js';

const USER_ID = 'fd055c6d-ec50-473a-bc0f-f50cc1e181c9';
const ADMIN_ID = 'ac6521ad-6a0e-4906-8b1d-2ef765476502';
const ORDER_ID = '0185353e-3876-4ff5-b277-62a2049ef060';
const ITEM_ID = '6a146823-3c06-4ad4-bc70-31869024db17';
const VARIANT_ID = '62acaea5-a5eb-4f3a-a34d-2aab26c76cf4';
const PRODUCT_ID = 'cde414c2-c54c-4b5d-9654-2107d27e2cc9';
const KEY = randomUUID();
const actor: AuthUser = { id: USER_ID, role: 'customer', sessionId: KEY };
const admin: AuthUser = { id: ADMIN_ID, role: 'admin', sessionId: KEY };

const order = {
  id: ORDER_ID,
  user_id: USER_ID,
  status: 'paid',
  fulfillment_status: 'ready',
  fulfillment_updated_at: new Date('2026-09-29T10:30:00.000Z'),
  payment_type: 'cod',
  total_minor: '2000',
  transfer_reference: null,
  created_at: new Date('2026-09-29T10:00:00.000Z'),
  updated_at: new Date('2026-09-29T11:00:00.000Z'),
  paid_at: new Date('2026-09-29T11:00:00.000Z'),
  cancelled_at: null,
};
const item = {
  id: ITEM_ID,
  order_id: ORDER_ID,
  product_id: PRODUCT_ID,
  variant_id: VARIANT_ID,
  product_name: 'Burger',
  variant_name: 'Large',
  quantity: 2,
  unit_price_minor: '1000',
  line_total_minor: '2000',
};

function database(query: ReturnType<typeof vi.fn>) {
  const runner = {
    connect: vi.fn(async () => undefined),
    startTransaction: vi.fn(async () => undefined),
    commitTransaction: vi.fn(async () => undefined),
    rollbackTransaction: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    query,
  };
  const source = { createQueryRunner: () => runner } as unknown as DataSource;
  return { source, runner };
}

describe('OrdersService transaction boundaries', () => {
  it('releases a checkout runner when transaction startup fails', async () => {
    const { source, runner } = database(vi.fn());
    runner.startTransaction.mockRejectedValueOnce(new Error('transaction startup failed'));
    await expect(new OrdersService(source).checkout(actor, KEY, '5', {
      paymentType: 'cod', expectedTotalMinor: 2000,
    })).rejects.toThrow('transaction startup failed');
    expect(runner.release).toHaveBeenCalledOnce();
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('releases an admin transaction runner when connection acquisition fails', async () => {
    const { source, runner } = database(vi.fn());
    runner.connect.mockRejectedValueOnce(new Error('pool wait expired'));
    await expect(new OrdersService(source).cancel(admin, ORDER_ID)).rejects.toThrow('pool wait expired');
    expect(runner.release).toHaveBeenCalledOnce();
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('rejects a demo checkout when simulated payments are disabled', async () => {
    const original = process.env.DEMO_PAYMENTS_ENABLED;
    delete process.env.DEMO_PAYMENTS_ENABLED;
    try {
      const query = vi.fn();
      const { source } = database(query);
      await expect(new OrdersService(source).checkout(actor, KEY, '5', { paymentType: 'demo', expectedTotalMinor: 2000 }))
        .rejects.toMatchObject({ status: 400 });
      expect(query).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.DEMO_PAYMENTS_ENABLED;
      else process.env.DEMO_PAYMENTS_ENABLED = original;
    }
  });

  it('replays the original checkout after the order was paid, without reading the cleared cart', async () => {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ paymentType: 'cod', expectedTotalMinor: 2000, cartVersion: 5 }))
      .digest('hex');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT request_hash, order_id FROM checkout_requests')) return [{ request_hash: fingerprint, order_id: ORDER_ID }];
      if (sql.includes('SELECT * FROM orders WHERE id')) return [order];
      if (sql.includes('SELECT * FROM order_items')) return [item];
      return [];
    });
    const { source, runner } = database(query);
    const result = await new OrdersService(source).checkout(actor, KEY, '5', { paymentType: 'cod', expectedTotalMinor: 2000 });
    expect(result).toMatchObject({ id: ORDER_ID, status: 'pending', paymentStatus: 'pending', totalMinor: 2000 });
    expect(result.items[0]).toMatchObject({ variantId: VARIANT_ID, lineTotalMinor: 2000 });
    expect(runner.commitTransaction).toHaveBeenCalledOnce();
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('FROM carts') || sql.includes('UPDATE variants'))).toBe(false);
  });

  it('rejects reuse of an idempotency key with a changed checkout request', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('FROM checkout_requests')
      ? [{ request_hash: 'other', order_id: ORDER_ID }]
      : []);
    const { source, runner } = database(query);
    await expect(new OrdersService(source).checkout(actor, KEY, '5', { paymentType: 'cod', expectedTotalMinor: 2000 }))
      .rejects.toMatchObject({ status: 409 });
    expect(runner.rollbackTransaction).toHaveBeenCalledOnce();
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('FROM carts'))).toBe(false);
  });

  it('rolls back checkout when stock is insufficient for any cart line', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM checkout_requests')) return [];
      if (sql.includes('SELECT id, version FROM carts')) return [{ id: KEY, version: 5 }];
      if (sql.includes('FROM cart_items ci') && sql.includes('AS variant_id')) return [{
        product_id: PRODUCT_ID,
        variant_id: VARIANT_ID,
        product_name: 'Burger',
        variant_name: 'Large',
        price_minor: '1000',
        stock: 0,
        active: true,
        quantity: 2,
      }];
      if (sql.includes('UPDATE variants SET stock = stock -')) return [[], 0];
      return [];
    });
    const { source, runner } = database(query);
    await expect(new OrdersService(source).checkout(actor, KEY, '5', { paymentType: 'cod', expectedTotalMinor: 2000 }))
      .rejects.toMatchObject({ status: 409 });
    expect(runner.rollbackTransaction).toHaveBeenCalledOnce();
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO orders'))).toBe(false);
  });

  it('restocks only on the first cancellation', async () => {
    let status: 'pending' | 'cancelled' = 'pending';
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM orders')) return [{ ...order, status, paid_at: null }];
      if (sql.includes('SELECT variant_id, quantity FROM order_items')) return [{ variant_id: VARIANT_ID, quantity: 2 }];
      if (sql.includes('UPDATE orders SET status')) status = 'cancelled';
      if (sql.includes('SELECT * FROM order_items')) return [item];
      return [];
    });
    const { source } = database(query);
    const service = new OrdersService(source);
    expect((await service.cancel(admin, ORDER_ID)).status).toBe('cancelled');
    expect((await service.cancel(admin, ORDER_ID)).status).toBe('cancelled');
    expect(query.mock.calls.filter(([sql]: [string]) => sql.includes('UPDATE variants SET stock = stock +'))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]: [string]) => sql.includes('INSERT INTO admin_audit'))).toHaveLength(1);
  });
});
