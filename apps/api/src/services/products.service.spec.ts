import { DataSource, EntityManager } from 'typeorm';
import { CatalogCacheService } from './catalog-cache.service.js';
import { ProductsService } from './products.service.js';

const PRODUCT_ID = '116b1428-b80c-427e-a244-672396ecff50';
const ACTOR_ID = 'ce562662-a389-49d5-a725-8be9ed34a022';

describe('ProductsService', () => {
  it('rejects edits to an archived product before writing or invalidating the catalog', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('SELECT archived_at FROM products')
      ? [{ archived_at: new Date() }]
      : []);
    const transaction = vi.fn(async (run: (tx: EntityManager) => Promise<unknown>) =>
      run({ query } as unknown as EntityManager));
    const invalidate = vi.fn(async () => undefined);
    const service = new ProductsService(
      { transaction } as unknown as DataSource,
      { invalidate } as unknown as CatalogCacheService,
    );

    await expect(service.update(PRODUCT_ID, { name: 'Changed' }, ACTOR_ID))
      .rejects.toMatchObject({ status: 409 });
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('UPDATE products SET name'))).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('deactivates child variants and audits product archival in one transaction', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('UPDATE products SET active = false')) return [{ id: PRODUCT_ID }];
      return [];
    });
    const transaction = vi.fn(async (run: (tx: EntityManager) => Promise<unknown>) =>
      run({ query } as unknown as EntityManager));
    const invalidate = vi.fn(async () => undefined);
    const db = { transaction } as unknown as DataSource;
    const cache = { invalidate } as unknown as CatalogCacheService;
    const service = new ProductsService(db, cache);
    vi.spyOn(service, 'get').mockResolvedValue({ id: PRODUCT_ID } as never);

    await service.archive(PRODUCT_ID, ACTOR_ID);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('UPDATE variants SET active = false'))).toBe(true);
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO admin_audit'))).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
