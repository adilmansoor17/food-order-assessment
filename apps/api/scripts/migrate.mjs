import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../migrations');
const client = new pg.Client({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? process.env.POSTGRES_PORT ?? '5433'),
  user: process.env.DB_USER ?? process.env.POSTGRES_USER ?? 'food_ordering',
  password: process.env.DB_PASSWORD ?? process.env.POSTGRES_PASSWORD ?? 'food_ordering_dev',
  database: process.env.DB_NAME ?? process.env.POSTGRES_DB ?? 'food_ordering',
});

await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    checksum text,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  // Older local installations created this table without a checksum.
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  const appliedNames = await client.query('SELECT name FROM schema_migrations');
  for (const row of appliedNames.rows) {
    if (!files.includes(row.name)) throw new Error(`Applied migration is missing from source: ${row.name}`);
  }
  for (const name of files) {
    const sql = await readFile(path.join(migrationsDir, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const applied = await client.query('SELECT checksum FROM schema_migrations WHERE name = $1', [name]);
    if (applied.rowCount) {
      if (applied.rows[0].checksum && applied.rows[0].checksum !== checksum) {
        throw new Error(`Applied migration checksum changed: ${name}`);
      }
      if (!applied.rows[0].checksum) {
        await client.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL', [name, checksum]);
        process.stdout.write(`Recorded legacy migration checksum for ${name}\n`);
      }
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(816903122)');
      const recheck = await client.query('SELECT checksum FROM schema_migrations WHERE name = $1', [name]);
      if (recheck.rowCount && recheck.rows[0].checksum !== checksum) {
        throw new Error(`Applied migration checksum changed: ${name}`);
      }
      if (!recheck.rowCount) {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      }
      await client.query('COMMIT');
      process.stdout.write(`Applied ${name}\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.end();
}
