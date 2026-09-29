import bcrypt from 'bcrypt';
import { randomInt, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { resetBrowserAuthRateCounters } from './test-db.mjs';

const databaseUrl = process.env.BROWSER_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.toLowerCase().endsWith('_test')) {
  throw new Error('Browser tests require an isolated *_test database');
}

test.beforeEach(resetBrowserAuthRateCounters);

async function withDatabase(work) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function uniquePhone() {
  return `+923${String(randomInt(1_000_000_000)).padStart(9, '0')}`;
}

async function seedAdmin(request, suffix) {
  const email = `browser-admin-${suffix}@example.com`;
  const password = 'BrowserAdminPass123!';
  const passwordHash = await bcrypt.hash(password, 10);
  await withDatabase((client) => client.query(
    `INSERT INTO users (id, name, email, phone_e164, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, 'admin')`,
    [randomUUID(), 'Browser Admin', email, uniquePhone(), passwordHash],
  ));
  const login = await request.post('/v1/auth/login', { data: { identifier: email, password } });
  expect(login.status()).toBe(200);
  return { email, password, token: (await login.json()).accessToken };
}

async function createProduct(request, token, name, suffix) {
  const created = await request.post('/v1/admin/products', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name,
      description: 'Browser test product',
      variants: [{ name: 'Regular', sku: `BROWSER-${suffix}`, priceMinor: 1250, initialStock: 10 }],
    },
  });
  expect(created.status()).toBe(201);
  return created.json();
}

async function registerCustomer(page, suffix, projectName) {
  const email = `browser-shopper-${suffix}-${projectName}@example.com`;
  await page.goto('/account');
  await page.getByRole('group', { name: 'Sign in method' }).getByRole('button', { name: 'Create account' }).click();
  const account = page.locator('form.auth-form');
  await account.getByRole('textbox', { name: 'Full name' }).fill('Browser Shopper');
  await account.getByRole('textbox', { name: 'Email' }).fill(email);
  await account.getByRole('textbox', { name: 'Phone' }).fill(uniquePhone());
  await account.getByLabel('Password').fill('BrowserShopperPass123!');
  await account.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Your account is ready.');
  return email;
}

async function signInAdmin(page, admin) {
  await page.goto('/account?return=%2Fadmin');
  const account = page.locator('form.auth-form');
  await expect(account.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await account.getByRole('textbox', { name: 'Email or phone' }).fill(admin.email);
  await account.getByLabel('Password').fill(admin.password);
  await account.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('You are signed in.');
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Manage the counter.' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Admin' })).toBeVisible();
}

async function signOut(page) {
  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 900) {
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Account' }).click();
    const account = page.locator('.account-panel');
    await expect(account.getByRole('heading', { name: 'Signed in' })).toBeVisible();
    await account.getByRole('button', { name: 'Sign out' }).click();
  } else {
    await page.locator('.masthead-account').getByRole('button', { name: 'Sign out' }).click();
  }
}

function adminOrderCard(page, orderId) {
  return page.getByRole('article', { name: `Order ${orderId.slice(0, 8)}` });
}

async function loadUntilVisible(target, nextPage) {
  await expect.poll(async () => await target.isVisible() || await nextPage.isVisible()).toBe(true);
  for (let pageNumber = 0; pageNumber < 50; pageNumber += 1) {
    if (await target.isVisible()) return;
    if (!(await nextPage.isVisible())) break;
    await nextPage.click();
  }
  await expect(target).toBeVisible();
}

function variantEditor(editor, sku) {
  return editor.getByRole('region', { name: `Variant ${sku}` });
}

test('bank transfer reference stays pending until admin records payment', async ({ page, request }, testInfo) => {
  const suffix = randomUUID().slice(0, 8);
  const productName = `Transfer meal ${suffix}`;
  const reference = `TRANSFER-${suffix}`;
  const admin = await seedAdmin(request, suffix);
  await createProduct(request, admin.token, productName, suffix);

  // Bank details are a controlled checkout-config fixture; checkout and payment requests use the real API.
  await page.route('**/v1/config/checkout', (route) => route.fulfill({
    json: { currency: 'PKR', bankTransfer: { bankName: 'Test Bank', accountName: 'Test Merchant', iban: 'PK00TEST0000000000000000' } },
  }));
  await registerCustomer(page, suffix, testInfo.project.name);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Admin' })).toHaveCount(0);
  const productHeading = page.getByRole('heading', { name: productName });
  await loadUntilVisible(productHeading, page.getByRole('button', { name: 'Load more dishes' }));
  const product = page.getByRole('article').filter({ has: productHeading });
  await product.getByRole('button', { name: 'Add to cart' }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /^Cart\b/ }).click();
  await page.getByRole('radio', { name: 'Bank transfer' }).check();
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Order placed. Payment is pending.');
  await expect(page).toHaveURL(/\/orders\?order=/);
  const orderId = new URL(page.url()).searchParams.get('order');
  expect(orderId).toMatch(/^[0-9a-f-]{36}$/i);

  const order = page.getByRole('article').filter({ has: page.getByRole('heading', { name: `Order ${orderId.slice(0, 8)}` }) });
  await expect(order.locator('.status-grid')).toContainText('pending');
  await expect(order).toContainText('Test Bank');
  await expect(order).toContainText('PK00TEST0000000000000000');
  await order.getByRole('textbox', { name: 'Transfer reference' }).fill('   ');
  await order.getByRole('button', { name: 'Save reference' }).click();
  await expect(order.getByRole('alert')).toContainText(/reference/i);
  const rejected = await withDatabase((client) => client.query('SELECT transfer_reference FROM orders WHERE id = $1', [orderId]));
  expect(rejected.rows[0].transfer_reference).toBeNull();

  await order.getByRole('textbox', { name: 'Transfer reference' }).fill(reference);
  await order.getByRole('button', { name: 'Save reference' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Transfer reference saved for review.');
  await expect(order.locator('.status-grid')).toContainText('pending');
  const pending = await withDatabase((client) => client.query(
    'SELECT status, transfer_reference FROM orders WHERE id = $1', [orderId],
  ));
  expect(pending.rows[0]).toMatchObject({ status: 'pending', transfer_reference: reference });

  await signOut(page);
  await signInAdmin(page, admin);
  const card = adminOrderCard(page, orderId);
  await loadUntilVisible(card, page.getByRole('button', { name: 'Load more orders' }));
  await expect(card).toContainText(`Reference: ${reference}`);
  await expect(card.getByRole('button', { name: 'Record payment' })).toHaveCount(0);

  // The browser runner does not launch a worker. Advance only this test order to ready
  // so the UI settlement state is exercised; worker processing has separate integration tests.
  await withDatabase(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        `UPDATE order_fulfillment_tasks SET status = 'ready', attempts = 1,
           processed_at = now(), updated_at = now() WHERE order_id = $1`, [orderId],
      );
      await client.query(
        `UPDATE orders SET fulfillment_status = 'ready', fulfillment_updated_at = now()
         WHERE id = $1`, [orderId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Manage the counter.' })).toBeVisible();
  const readyCard = adminOrderCard(page, orderId);
  await loadUntilVisible(readyCard, page.getByRole('button', { name: 'Load more orders' }));
  await expect(readyCard.getByRole('button', { name: 'Record payment' })).toBeVisible();
  await readyCard.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Payment recorded.');
  await expect(readyCard).toContainText('Order: paid · Payment: paid · Fulfillment: ready');
  const paid = await withDatabase((client) => client.query(
    `SELECT o.status, o.transfer_reference, count(a.id)::int AS audit_count
     FROM orders o LEFT JOIN admin_audit a ON a.target_id = o.id AND a.action = 'order.mark_paid'
     WHERE o.id = $1 GROUP BY o.id`, [orderId],
  ));
  expect(paid.rows[0]).toMatchObject({ status: 'paid', transfer_reference: reference, audit_count: 1 });
});

test('admin creates, edits, and archives a product in the browser', async ({ page, request }, testInfo) => {
  const suffix = randomUUID().slice(0, 8);
  const name = `Admin special ${suffix}`;
  const updatedName = `Updated special ${suffix}`;
  const admin = await seedAdmin(request, `${suffix}-${testInfo.project.name}`);
  await page.goto('/');
  await signInAdmin(page, admin);
  const catalog = page.getByRole('region', { name: 'Add a product' });
  await catalog.getByRole('textbox', { name: 'Product name' }).fill(name);
  await catalog.getByRole('textbox', { name: 'Description' }).fill('Fresh test special');
  await catalog.getByRole('textbox', { name: 'First variant name' }).fill('Large');
  await catalog.getByRole('textbox', { name: 'SKU' }).fill(`ADMIN-${suffix}`);
  await catalog.getByRole('spinbutton', { name: 'Price in paisa' }).fill('1799');
  await catalog.getByRole('spinbutton', { name: 'Initial stock' }).fill('7');
  await catalog.getByRole('button', { name: 'Create product' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Product created.');

  const manage = page.getByRole('region', { name: 'Manage products' });
  const productRow = manage.getByRole('article', { name: `Product ${name}` });
  await loadUntilVisible(productRow, manage.getByRole('button', { name: 'Load more products' }));
  await productRow.getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('region', { name: `Edit ${name}` });
  const addVariant = editor.locator('form.add-variant');
  await addVariant.getByRole('textbox', { name: 'Variant name' }).fill('Family');
  await addVariant.getByRole('textbox', { name: 'SKU' }).fill(`FAMILY-${suffix}`);
  await addVariant.getByRole('spinbutton', { name: 'Price in paisa' }).fill('2199');
  await addVariant.getByRole('spinbutton', { name: 'Initial stock' }).fill('3');
  await addVariant.getByRole('button', { name: 'Add variant' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Variant added.');

  const family = variantEditor(editor, `FAMILY-${suffix}`);
  await expect(family).toContainText('STOCK 3');
  await family.getByRole('spinbutton', { name: 'Stock change' }).fill('2');
  await family.getByRole('textbox', { name: 'Reason for adjustment' }).fill('Browser assessment fixture');
  await family.getByRole('button', { name: 'Adjust stock' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Stock adjusted.');
  await expect(family).toContainText('STOCK 5');

  await family.getByRole('textbox', { name: 'Variant name' }).fill('Family feast');
  await family.getByRole('spinbutton', { name: 'Price in paisa' }).fill('2299');
  await family.getByRole('button', { name: 'Save variant' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Variant updated.');
  await expect(variantEditor(editor, `FAMILY-${suffix}`).getByRole('textbox', { name: 'Variant name' })).toHaveValue('Family feast');
  page.once('dialog', (dialog) => dialog.accept());
  await variantEditor(editor, `FAMILY-${suffix}`).getByRole('button', { name: 'Archive variant' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Variant archived.');
  await expect(variantEditor(editor, `FAMILY-${suffix}`).getByRole('checkbox', { name: 'Available on menu' })).not.toBeChecked();
  await expect(variantEditor(editor, `FAMILY-${suffix}`).getByRole('button', { name: 'Archive variant' })).toBeDisabled();

  await editor.getByRole('textbox', { name: 'Product name' }).fill(updatedName);
  await editor.getByRole('textbox', { name: 'Description' }).fill('Updated test special');
  await editor.getByRole('button', { name: 'Save product' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Product updated.');
  const updatedRow = manage.getByRole('article', { name: `Product ${updatedName}` });
  await loadUntilVisible(updatedRow, manage.getByRole('button', { name: 'Load more products' }));
  page.once('dialog', (dialog) => dialog.accept());
  await updatedRow.getByRole('button', { name: 'Archive' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Product archived.');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Menu' }).click();
  await expect(page.getByRole('heading', { name: updatedName })).toHaveCount(0);
  const archived = await withDatabase((client) => client.query(
    `SELECT p.name, p.active AS product_active, p.archived_at, v.sku, v.name AS variant_name,
            v.active AS variant_active, v.stock, v.price_minor
     FROM products p JOIN variants v ON v.product_id = p.id
     WHERE v.sku IN ($1, $2) ORDER BY v.sku`, [`ADMIN-${suffix}`, `FAMILY-${suffix}`],
  ));
  expect(archived.rows).toHaveLength(2);
  expect(archived.rows[0]).toMatchObject({ name: updatedName, product_active: false, variant_active: false, stock: 7 });
  expect(archived.rows[1]).toMatchObject({ name: updatedName, product_active: false, variant_name: 'Family feast', variant_active: false, stock: 5 });
  expect(Number(archived.rows[1].price_minor)).toBe(2299);
  expect(archived.rows[0].archived_at).not.toBeNull();
});

test('checkout retries with the same key after its successful response is lost', async ({ page, request }, testInfo) => {
  const suffix = randomUUID().slice(0, 8);
  const productName = `Retry meal ${suffix}`;
  const admin = await seedAdmin(request, suffix);
  await createProduct(request, admin.token, productName, suffix);
  const customerEmail = await registerCustomer(page, suffix, testInfo.project.name);
  const productHeading = page.getByRole('heading', { name: productName });
  await loadUntilVisible(productHeading, page.getByRole('button', { name: 'Load more dishes' }));
  const product = page.getByRole('article').filter({ has: productHeading });
  await product.getByRole('button', { name: 'Add to cart' }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /^Cart\b/ }).click();

  const keys = [];
  await page.getByRole('radio', { name: 'Cash on delivery' }).check();
  await page.route('**/v1/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']);
    if (keys.length === 1) {
      // Let the API commit, then drop the browser-visible response.
      await route.fetch().catch(() => undefined);
      return route.abort('failed');
    }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.locator('form.checkout-panel').getByRole('alert')).toBeVisible();
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  await expect.poll(async () => (await withDatabase((client) => client.query(
    'SELECT count(*)::int AS count FROM checkout_requests WHERE idempotency_key = $1', [keys[0]],
  ))).rows[0].count).toBe(1);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('checkout-attempt') ?? 'null')?.key)).toBe(keys[0]);

  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Order placed. Payment is pending.');
  await expect(page).toHaveURL(/\/orders\?order=/);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(await page.evaluate(() => sessionStorage.getItem('checkout-attempt'))).toBeNull();
  const committed = await withDatabase(async (client) => ({
    orders: await client.query(
      `SELECT o.id FROM orders o JOIN users u ON u.id = o.user_id WHERE u.email = $1`, [customerEmail],
    ),
    requests: await client.query(
      'SELECT order_id FROM checkout_requests WHERE idempotency_key = $1', [keys[0]],
    ),
  }));
  expect(committed.orders.rows).toHaveLength(1);
  expect(committed.requests.rows).toHaveLength(1);
  expect(committed.requests.rows[0].order_id).toBe(committed.orders.rows[0].id);
});
