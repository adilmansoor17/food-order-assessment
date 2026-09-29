import pg from 'pg';

const databaseUrl = process.env.BROWSER_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.toLowerCase().endsWith('_test')) {
  throw new Error('Browser tests require an isolated _test database');
}

export async function resetBrowserAuthRateCounters() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Browser projects share loopback IP but exercise independent users.
    await client.query('DELETE FROM auth_rate_counters');
  } finally {
    await client.end();
  }
}
