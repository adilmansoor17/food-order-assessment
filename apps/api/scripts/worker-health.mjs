import amqp from 'amqplib';
import pg from 'pg';

let connection;
let channel;
let database;

try {
  if (!process.env.RABBITMQ_URL) throw new Error('RABBITMQ_URL is missing');
  const ownConsumers = await fetch('http://127.0.0.1:3002/health', {
    signal: AbortSignal.timeout(3000),
  });
  if (!ownConsumers.ok) throw new Error('This worker has an inactive consumer');
  connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await connection.createChannel();
  await Promise.all([
    channel.checkQueue('food.orders.process'),
    channel.checkQueue('food.notifications'),
  ]);

  database = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionTimeoutMillis: 3000,
  });
  await database.connect();
  await database.query('SELECT 1');
} catch (error) {
  const value = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = typeof value === 'string' && /^[A-Z0-9_]{1,32}$/.test(value) ? ` (${value})` : '';
  console.error(`Worker health check failed${code}`);
  process.exitCode = 1;
} finally {
  await database?.end().catch(() => undefined);
  await channel?.close().catch(() => undefined);
  await connection?.close().catch(() => undefined);
}
