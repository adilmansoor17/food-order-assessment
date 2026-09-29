import { defineConfig, devices } from '@playwright/test';

const apiUrl = 'http://localhost:3001';
const webUrl = 'http://localhost:3000';
const databaseUrl = process.env.BROWSER_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.toLowerCase().endsWith('_test')) {
  throw new Error('Browser tests require BROWSER_TEST_DATABASE_URL or TEST_DATABASE_URL pointing to an isolated test database');
}
const database = new URL(databaseUrl);

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: webUrl, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'npm run db:migrate && npm run dev:api',
      url: `${apiUrl}/v1/health/ready`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test',
        DEMO_PAYMENTS_ENABLED: 'true',
        OTP_DELIVERY_MODE: 'test',
        DB_HOST: database.hostname,
        DB_PORT: database.port || '5432',
        DB_USER: decodeURIComponent(database.username),
        DB_PASSWORD: decodeURIComponent(database.password),
        DB_NAME: decodeURIComponent(database.pathname.slice(1)),
        // Browser fixtures insert catalog rows directly, so bypass shared Redis cache state.
        REDIS_URL: 'redis://127.0.0.1:1',
      },
    },
    {
      command: 'npm run dev:web',
      url: webUrl,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { NODE_ENV: 'development', NEXT_PUBLIC_API_BASE_URL: '/v1', API_INTERNAL_URL: apiUrl },
    },
  ],
});
