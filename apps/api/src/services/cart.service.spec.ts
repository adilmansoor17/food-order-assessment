import { DataSource, EntityManager } from 'typeorm';
import { CartService, parseCartVersion } from './cart.service.js';

const USER_ID = 'fd055c6d-ec50-473a-bc0f-f50cc1e181c9';
const VARIANT_ID = '62acaea5-a5eb-4f3a-a34d-2aab26c76cf4';
const CART_ID = '5b12f795-aac5-4498-9187-8310267e2d5e';

function fakeDatabase(query: ReturnType<typeof vi.fn>) {
  const manager = { query } as unknown as EntityManager;
  return {
    transaction: vi.fn(async (run: (tx: EntityManager) => Promise<unknown>) => run(manager)),
  } as unknown as DataSource;
}

describe('CartService', () => {
  it('requires a valid If-Match cart version', () => {
    expect(parseCartVersion('"5"')).toBe(5);
    expect(parseCartVersion('5')).toBe(5);
    expect(() => parseCartVersion(undefined)).toThrow();
    expect(() => parseCartVersion('"abc"')).toThrow();
  });

  it('rejects a stale edit before checking or changing inventory', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id, version FROM carts')) return [{ id: CART_ID, version: 3 }];
      return [];
    });
    const cart = new CartService(fakeDatabase(query));
    await expect(cart.putItem(USER_ID, VARIANT_ID, 2, 2)).rejects.toMatchObject({ status: 412 });
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('cart_items'))).toBe(false);
  });

  it('rejects quantity above current stock without a cart-item write', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id, version FROM carts')) return [{ id: CART_ID, version: 1 }];
      if (sql.includes('SELECT v.stock FROM variants')) return [{ stock: 1 }];
      return [];
    });
    const cart = new CartService(fakeDatabase(query));
    await expect(cart.putItem(USER_ID, VARIANT_ID, 2, 1)).rejects.toMatchObject({ status: 409 });
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO cart_items'))).toBe(false);
  });

  it('returns authoritative priced totals after a successful edit', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id, version FROM carts')) return [{ id: CART_ID, version: 1 }];
      if (sql.includes('SELECT v.stock FROM variants')) return [{ stock: 4 }];
      if (sql.includes('SELECT count(*)::int AS count FROM cart_items')) return [{ count: 0 }];
      if (sql.includes('SELECT c.id, c.version, ci.variant_id')) {
        return [{
          id: CART_ID,
          version: 2,
          variant_id: VARIANT_ID,
          product_id: 'cde414c2-c54c-4b5d-9654-2107d27e2cc9',
          product_name: 'Burger',
          variant_name: 'Large',
          price_minor: '1250',
          stock: 4,
          variant_active: true,
          product_active: true,
          archived_at: null,
          quantity: 2,
        }];
      }
      return [];
    });
    const cart = new CartService(fakeDatabase(query));
    const result = await cart.putItem(USER_ID, VARIANT_ID, 2, 1);
    expect(result).toMatchObject({ version: 2, totalMinor: 2500, estimatedTotalMinor: 2500 });
    expect(result.items[0]).toMatchObject({ unitPriceMinor: 1250, lineTotalMinor: 2500, available: true });
  });

  it('rejects a new line when the cart already has 100 distinct variants', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id, version FROM carts')) return [{ id: CART_ID, version: 1 }];
      if (sql.includes('SELECT v.stock FROM variants')) return [{ stock: 4 }];
      if (sql.includes('SELECT count(*)::int AS count FROM cart_items')) return [{ count: 100 }];
      return [];
    });
    const cart = new CartService(fakeDatabase(query));
    await expect(cart.putItem(USER_ID, VARIANT_ID, 1, 1))
      .rejects.toMatchObject({ status: 409 });
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO cart_items'))).toBe(false);
  });
});
