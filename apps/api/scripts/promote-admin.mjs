import pg from 'pg';
import { randomUUID } from 'node:crypto';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || process.argv[3] !== '--confirm') {
  throw new Error('Usage: npm run admin:promote --workspace api -- user@example.com --confirm');
}

const client = new pg.Client({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? process.env.POSTGRES_PORT ?? '5433'),
  user: process.env.DB_USER ?? process.env.POSTGRES_USER ?? 'food_ordering',
  password: process.env.DB_PASSWORD ?? process.env.POSTGRES_PASSWORD ?? 'food_ordering_dev',
  database: process.env.DB_NAME ?? process.env.POSTGRES_DB ?? 'food_ordering',
});

await client.connect();
try {
  await client.query('BEGIN');
  const result = await client.query(
    `SELECT id, role FROM users WHERE email = $1 AND status = 'active' FOR UPDATE`,
    [email],
  );
  const user = result.rows[0];
  if (!user) throw new Error('No active registered user has that email');
  if (user.role !== 'admin') {
    await client.query(`UPDATE users SET role = 'admin', updated_at = now() WHERE id = $1`, [user.id]);
    await client.query(
      `INSERT INTO admin_audit (id, actor_id, action, target_id, metadata)
       VALUES ($1, $2, 'user.promote_admin', $2, $3::jsonb)`,
      [randomUUID(), user.id, JSON.stringify({ source: 'operator_cli' })],
    );
  }
  await client.query('COMMIT');
  process.stdout.write(user.role === 'admin' ? 'User is already an admin\n' : 'Admin access granted\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
