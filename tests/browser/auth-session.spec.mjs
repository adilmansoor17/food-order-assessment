import { randomInt, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { resetBrowserAuthRateCounters } from './test-db.mjs';

test.beforeEach(resetBrowserAuthRateCounters);

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

test('phone password login restores the session after reload and logout clears it', async ({ page }, testInfo) => {
  const suffix = randomUUID().slice(0, 8);
  const phone = `+923${String(randomInt(1_000_000_000)).padStart(9, '0')}`;
  const password = 'BrowserSessionPass123!';

  await page.goto('/account');
  await page.getByRole('group', { name: 'Sign in method' }).getByRole('button', { name: 'Create account' }).click();
  let account = page.locator('form.auth-form');
  await account.getByRole('textbox', { name: 'Full name' }).fill('Browser Session');
  await account.getByRole('textbox', { name: 'Email' }).fill(`session-${suffix}-${testInfo.project.name}@example.com`);
  await account.getByRole('textbox', { name: 'Phone' }).fill(phone);
  await account.getByLabel('Password').fill(password);
  await account.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('Your account is ready.');

  await signOut(page);
  await page.goto('/account');
  account = page.locator('form.auth-form');
  await expect(account.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await account.getByRole('textbox', { name: 'Email or phone' }).fill(phone);
  await account.getByLabel('Password').fill('WrongSessionPass123!');
  await account.getByRole('button', { name: 'Sign in' }).click();
  await expect(account.getByRole('alert')).toBeVisible();
  await expect(account.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await account.getByLabel('Password').fill(password);
  await account.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.notice-region').getByRole('status')).toContainText('You are signed in.');

  await page.goto('/cart');
  await expect(page.getByRole('heading', { name: 'Review your cart.' })).toBeVisible();
  await expect(page.getByText('Your cart is empty.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Your cart is empty.')).toBeVisible();
  await signOut(page);
  await page.goto('/cart');
  await expect(page.getByRole('heading', { name: 'Sign in to start an order.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});
