import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { resetBrowserAuthRateCounters } from './test-db.mjs';

const databaseUrl = process.env.BROWSER_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.toLowerCase().endsWith('_test')) {
  throw new Error('Browser tests require BROWSER_TEST_DATABASE_URL or TEST_DATABASE_URL pointing to an isolated test database');
}

test.beforeEach(resetBrowserAuthRateCounters);

async function loadUntilVisible(target, nextPage) {
  await expect.poll(async () => await target.isVisible() || await nextPage.isVisible()).toBe(true);
  for (let pageNumber = 0; pageNumber < 50 && !(await target.isVisible()); pageNumber += 1) {
    await nextPage.click();
  }
  await expect(target).toBeVisible();
}

test('customer registers, adds a variant, and places an order', async ({ page }, testInfo) => {
  const productId = randomUUID();
  const variantId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const productName = `Browser burger ${suffix}`;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      'INSERT INTO products (id, name, description) VALUES ($1, $2, $3)',
      [productId, productName, 'Browser checkout test product'],
    );
    await client.query(
      'INSERT INTO variants (id, product_id, name, sku, price_minor, stock) VALUES ($1, $2, $3, $4, $5, $6)',
      [variantId, productId, 'Single', `browser-${suffix}`, 1250, 10],
    );
  } finally {
    await client.end();
  }

  await page.goto('/');
  const productHeading = page.getByRole('heading', { name: productName });
  await loadUntilVisible(productHeading, page.getByRole('button', { name: 'Load more dishes' }));

  await page.goto('/account');
  await page.getByRole('group', { name: 'Sign in method' }).getByRole('button', { name: 'Create account' }).click();
  const account = page.locator('form.auth-form');
  await account.getByRole('textbox', { name: 'Full name' }).fill('Browser Shopper');
  await account.getByRole('textbox', { name: 'Email' }).fill(`browser-${suffix}-${testInfo.project.name}@example.com`);
  await account.getByRole('textbox', { name: 'Phone' }).fill(`+923${String(Date.now() % 1_000_000_000).padStart(9, '0')}`);
  await account.getByLabel('Password').fill('BrowserTestPassw0rd!');
  await account.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Your account is ready.');

  await expect(page).toHaveURL(/\/$/);
  await loadUntilVisible(productHeading, page.getByRole('button', { name: 'Load more dishes' }));
  const product = page.getByRole('article').filter({ has: productHeading });
  await product.getByRole('button', { name: 'Add to cart' }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /^Cart\b/ }).click();
  const cartLine = page.locator('.cart-item-list').getByRole('article').filter({
    has: page.getByRole('heading', { name: productName, exact: true }),
  });
  await expect(cartLine).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Demo payment — no money charged' })).toBeChecked();
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/orders\?order=/);
  await expect(page.getByRole('heading', { name: 'Follow your order.' })).toBeVisible();
  await expect(page.getByRole('article').filter({ has: page.getByRole('heading', { name: /^Order [0-9a-f]{8}$/i }) })).toContainText('pending');
  await expect(page.getByText(/Your order is queued/)).toBeVisible();
  await expect(page.getByText('Payment method: Demo payment — no money charged')).toBeVisible();
});
