import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { OrderRateLimitService } from './order-rate-limit.service.js';

describe('OrderRateLimitService', () => {
  it('limits new checkouts per account across requests and returns retry guidance', async () => {
    const counts = new Map<string, number>();
    const query = vi.fn(async (_sql: string, [key, , ceiling]: [string, number, number]) => {
      const next = Math.min((counts.get(key) ?? 0) + 1, ceiling);
      counts.set(key, next);
      return [{ count: next }];
    });
    const db = { query } as unknown as DataSource;
    const config = { get: (key: string) => key === 'AUTH_TOKEN_HASH_SECRET' ? 'a'.repeat(32) : undefined } as ConfigService;
    const limits = new OrderRateLimitService(db, config);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await limits.checkout('customer-one');
    }
    await expect(limits.checkout('customer-one')).rejects.toMatchObject({
      status: 429,
      response: { code: 'RATE_LIMITED', retryAfterSeconds: expect.any(Number) },
    });
    await expect(limits.checkout('customer-two')).resolves.toBeUndefined();
    expect(counts.size).toBe(2);
    expect(query.mock.calls.at(-2)?.[0]).toContain('ON CONFLICT');
  });
});
