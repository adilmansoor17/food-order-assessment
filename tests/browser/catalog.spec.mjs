import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { resetBrowserAuthRateCounters } from './test-db.mjs';

const databaseUrl = process.env.BROWSER_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.toLowerCase().endsWith('_test')) {
  throw new Error('Catalog browser tests require an isolated _test database');
}

test.beforeEach(resetBrowserAuthRateCounters);

test('loads a food product beyond the first catalog page', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const targetName = `Later page burger ${suffix}`;
  const products = Array.from({ length: 21 }, (_, index) => ({
    id: randomUUID(),
    variantId: randomUUID(),
    name: index === 20 ? targetName : `First page burger ${suffix}-${index}`,
    createdAt: index === 20 ? '2100-01-01T00:00:00Z' : '2100-01-02T00:00:00Z',
    sku: `catalog-${suffix}-${index}`,
  }));
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let seeded = false;
  try {
    await client.query('BEGIN');
    for (const product of products) {
      await client.query(
        'INSERT INTO products (id, name, description, created_at) VALUES ($1, $2, $3, $4)',
        [product.id, product.name, 'Pagination browser test', product.createdAt],
      );
      await client.query(
        'INSERT INTO variants (id, product_id, name, sku, price_minor, stock) VALUES ($1, $2, $3, $4, $5, $6)',
        [product.variantId, product.id, 'Single', product.sku, 1250, 10],
      );
    }
    await client.query('COMMIT');
    seeded = true;

    await page.goto('/');
    const target = page.getByRole('heading', { name: targetName });
    await expect(page.getByRole('button', { name: 'Load more dishes' })).toBeVisible();
    await expect(target).not.toBeVisible();
    for (let attempt = 0; attempt < 30 && !(await target.isVisible()); attempt += 1) {
      await page.getByRole('button', { name: 'Load more dishes' }).click();
    }
    await expect(target).toBeVisible();
    await expect(target).toHaveCount(1);
  } finally {
    try {
      if (seeded) {
        const ids = products.map((product) => product.id);
        await client.query('DELETE FROM variants WHERE product_id = ANY($1::uuid[])', [ids]);
        await client.query('DELETE FROM products WHERE id = ANY($1::uuid[])', [ids]);
      } else {
        await client.query('ROLLBACK');
      }
    } finally {
      await client.end();
    }
  }
});
