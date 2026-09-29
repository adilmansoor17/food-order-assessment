import type { OrdersService } from '../services/orders.service.js';
import type { OrderRateLimitService } from '../services/order-rate-limit.service.js';
import { OrdersController } from './orders.controller.js';

describe('OrdersController checkout admission', () => {
  it('returns a retryable 503 at 32 in-flight checkouts and releases capacity afterward', async () => {
    let finish!: (value: { id: string }) => void;
    const deferred = new Promise<{ id: string }>((resolve) => { finish = resolve; });
    const checkout = vi.fn(() => deferred);
    const orders = { checkout, isCheckoutReplay: vi.fn().mockResolvedValue(false) } as unknown as OrdersService;
    const rateLimits = { checkout: vi.fn().mockResolvedValue(undefined) } as unknown as OrderRateLimitService;
    const controller = new OrdersController(orders, rateLimits);
    const req = { user: { id: 'fd055c6d-ec50-473a-bc0f-f50cc1e181c9', role: 'customer' } } as Parameters<OrdersController['checkout']>[0];
    const setHeader = vi.fn();
    const response = { setHeader } as unknown as Parameters<OrdersController['checkout']>[1];
    const args = [req, response, 'ae2ae312-7e06-4bd2-8421-97218948b447', '1', { paymentType: 'cod', expectedTotalMinor: 1 }] as const;
    const pending = Array.from({ length: 32 }, () => controller.checkout(...args));

    await expect(controller.checkout(...args)).rejects.toMatchObject({ status: 503 });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '1');
    expect(checkout).toHaveBeenCalledTimes(32);

    finish({ id: 'order-1' });
    await Promise.all(pending);
    await expect(controller.checkout(...args)).resolves.toMatchObject({ id: 'order-1' });
    expect(checkout).toHaveBeenCalledTimes(33);
  });

  it('returns a retryable 503 for a transient PostgreSQL capacity error', async () => {
    const cause = Object.assign(new Error('too many connections'), { code: '53300' });
    const orders = { checkout: vi.fn().mockRejectedValue(cause), isCheckoutReplay: vi.fn().mockResolvedValue(false) } as unknown as OrdersService;
    const rateLimits = { checkout: vi.fn().mockResolvedValue(undefined) } as unknown as OrderRateLimitService;
    const controller = new OrdersController(orders, rateLimits);
    const req = { user: { id: 'fd055c6d-ec50-473a-bc0f-f50cc1e181c9', role: 'customer' } } as Parameters<OrdersController['checkout']>[0];
    const setHeader = vi.fn();
    const response = { setHeader } as unknown as Parameters<OrdersController['checkout']>[1];

    await expect(controller.checkout(req, response, 'ae2ae312-7e06-4bd2-8421-97218948b447', '1', {
      paymentType: 'cod', expectedTotalMinor: 1,
    })).rejects.toMatchObject({ status: 503, cause });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '1');
  });

  it('allows an idempotent checkout replay after the account reaches its new-attempt limit', async () => {
    const order = { id: 'existing-order' };
    const orders = { checkout: vi.fn().mockResolvedValue(order), isCheckoutReplay: vi.fn().mockResolvedValue(true) } as unknown as OrdersService;
    const checkoutLimit = vi.fn().mockRejectedValue(new Error('limit reached'));
    const readLimit = vi.fn().mockResolvedValue(undefined);
    const rateLimits = { checkout: checkoutLimit, read: readLimit } as unknown as OrderRateLimitService;
    const controller = new OrdersController(orders, rateLimits);
    const req = { user: { id: 'fd055c6d-ec50-473a-bc0f-f50cc1e181c9', role: 'customer' } } as Parameters<OrdersController['checkout']>[0];
    const response = { setHeader: vi.fn() } as unknown as Parameters<OrdersController['checkout']>[1];

    await expect(controller.checkout(req, response, 'ae2ae312-7e06-4bd2-8421-97218948b447', '1', {
      paymentType: 'cod', expectedTotalMinor: 1,
    })).resolves.toBe(order);
    expect(checkoutLimit).not.toHaveBeenCalled();
    expect(readLimit).toHaveBeenCalledWith(req.user.id);
  });
});
