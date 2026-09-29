import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const count = boundedInteger('LOAD_ORDERS', 100, 1, 1_000);
const concurrency = boundedInteger('LOAD_CONCURRENCY', 20, 1, 100);
const replayEvery = boundedInteger('LOAD_REPLAY_EVERY', 0, 0, 100);
const variantMode = process.env.LOAD_VARIANT_MODE ?? 'distributed';
if (!['distributed', 'hot'].includes(variantMode)) throw new Error('LOAD_VARIANT_MODE must be distributed or hot');

function boundedInteger(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function testDatabaseUrl() {
  const raw = process.env.LOAD_TEST_DATABASE_URL;
  if (!raw) throw new Error('LOAD_TEST_DATABASE_URL is required and must target a dedicated test database');
  const parsed = new URL(raw);
  if (!decodeURIComponent(parsed.pathname.slice(1)).toLowerCase().includes('test')) {
    throw new Error('LOAD_TEST_DATABASE_URL database name must contain test');
  }
  if (!['localhost', '127.0.0.1', 'postgres'].includes(parsed.hostname)) {
    throw new Error('LOAD_TEST_DATABASE_URL must target a local test PostgreSQL server');
  }
  return parsed;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] * 100) / 100;
}

async function main() {
  const baseUrl = testDatabaseUrl();
  const temporaryName = `food_ordering_test_load_${randomUUID().slice(0, 8)}`;
  const temporaryUrl = new URL(baseUrl);
  temporaryUrl.pathname = `/${temporaryName}`;
  const controlDb = new DataSource({ type: 'postgres', url: baseUrl.toString(), synchronize: false });
  let workloadDb;
  let app;
  let created = false;
  try {
    await controlDb.initialize();
    await controlDb.query(`CREATE DATABASE "${temporaryName}"`);
    created = true;
    workloadDb = new DataSource({ type: 'postgres', url: temporaryUrl.toString(), synchronize: false });
    await workloadDb.initialize();
    await workloadDb.query(await readFile(join(scriptDirectory, '../migrations/001_initial.sql'), 'utf8'));
    await workloadDb.query(await readFile(join(scriptDirectory, '../migrations/002_fulfillment.sql'), 'utf8'));
    await workloadDb.query(await readFile(join(scriptDirectory, '../migrations/003_order_admin_index.sql'), 'utf8'));
    await workloadDb.query(await readFile(join(scriptDirectory, '../migrations/004_simulated_payments.sql'), 'utf8'));

    const accessSecret = randomBytes(32).toString('hex');
    const refreshSecret = randomBytes(32).toString('hex');
    process.env.NODE_ENV = 'test';
    process.env.DB_HOST = temporaryUrl.hostname;
    process.env.DB_PORT = temporaryUrl.port || '5432';
    process.env.DB_USER = decodeURIComponent(temporaryUrl.username);
    process.env.DB_PASSWORD = decodeURIComponent(temporaryUrl.password);
    process.env.DB_NAME = temporaryName;
    process.env.JWT_ACCESS_SECRET = accessSecret;
    process.env.JWT_REFRESH_SECRET = refreshSecret;
    process.env.OTP_PEPPER = randomBytes(32).toString('hex');
    process.env.OTP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.AUTH_TOKEN_HASH_SECRET = randomBytes(32).toString('hex');
    process.env.OTP_DELIVERY_MODE = 'test';
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    process.env.WEB_ORIGIN = 'http://localhost:3000';

    const { AppModule } = await import('../dist/routes/app.module.js');
    const { HttpErrorFilter } = await import('../dist/middlewares/http-exception.filter.js');
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpErrorFilter());
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpServer().address().port;
    const endpoint = `http://127.0.0.1:${port}/v1/orders`;
    const jwt = new JwtService();
    const contexts = [];
    let hotVariantId;
    if (variantMode === 'hot') {
      const productId = randomUUID();
      hotVariantId = randomUUID();
      await workloadDb.query('INSERT INTO products (id, name) VALUES ($1,$2)', [productId, 'Load Burger']);
      await workloadDb.query(
        'INSERT INTO variants (id, product_id, name, sku, price_minor, stock) VALUES ($1,$2,$3,$4,$5,$6)',
        [hotVariantId, productId, 'Regular', `LOAD-${hotVariantId}`, 1250, count],
      );
    }
    for (let index = 0; index < count; index += 1) {
      const userId = randomUUID();
      const sessionId = randomUUID();
      const cartId = randomUUID();
      const variantId = hotVariantId ?? randomUUID();
      await workloadDb.query(
        `INSERT INTO users (id, name, email, phone_e164, password_hash, email_verified_at, phone_verified_at)
         VALUES ($1,$2,$3,$4,$5,now(),now())`,
        [userId, 'Load User', `load-${userId}@example.invalid`, `+9231${String(index).padStart(9, '0')}`, 'load-only'],
      );
      await workloadDb.query(
        'INSERT INTO sessions (id, user_id, family_id, token_hash, expires_at) VALUES ($1,$2,$3,$4,now() + interval \'1 hour\')',
        [sessionId, userId, randomUUID(), randomUUID()],
      );
      if (!hotVariantId) {
        const productId = randomUUID();
        await workloadDb.query('INSERT INTO products (id, name) VALUES ($1,$2)', [productId, 'Load Burger']);
        await workloadDb.query(
          'INSERT INTO variants (id, product_id, name, sku, price_minor, stock) VALUES ($1,$2,$3,$4,$5,$6)',
          [variantId, productId, 'Regular', `LOAD-${variantId}`, 1250, 1],
        );
      }
      await workloadDb.query('INSERT INTO carts (id, user_id) VALUES ($1,$2)', [cartId, userId]);
      await workloadDb.query('INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1,$2,1)', [cartId, variantId]);
      const token = jwt.sign(
        { sub: userId, sid: sessionId, typ: 'access' },
        { secret: accessSecret, expiresIn: 900, issuer: 'food-ordering-api', audience: 'food-ordering-web' },
      );
      contexts.push({ token, key: randomUUID(), orderId: null });
    }

    const latencies = [];
    const result = { success: 0, conflicts: 0, errors: 0, replays: 0, errorStatuses: {} };
    let next = 0;
    const startedAt = performance.now();
    async function send(index, replay = false) {
      const context = contexts[index];
      const sentAt = performance.now();
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${context.token}`,
            'content-type': 'application/json',
            'idempotency-key': context.key,
            'if-match': '0',
          },
          body: JSON.stringify({ paymentType: 'cod', expectedTotalMinor: 1250 }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = await response.json();
        latencies.push(performance.now() - sentAt);
        if (response.status === 201 && typeof body.id === 'string') {
          if (replay) {
            if (body.id === context.orderId) result.replays += 1;
            else {
              result.errors += 1;
              result.errorStatuses.replayMismatch = (result.errorStatuses.replayMismatch ?? 0) + 1;
              return false;
            }
          } else {
            context.orderId = body.id;
            result.success += 1;
          }
          return true;
        } else if (response.status === 409 || response.status === 412) {
          result.conflicts += 1;
        } else {
          result.errors += 1;
          result.errorStatuses[String(response.status)] = (result.errorStatuses[String(response.status)] ?? 0) + 1;
        }
      } catch {
        latencies.push(performance.now() - sentAt);
        result.errors += 1;
        result.errorStatuses.network = (result.errorStatuses.network ?? 0) + 1;
      }
      return false;
    }
    async function worker() {
      while (next < count) {
        const index = next++;
        const committed = await send(index);
        if (committed && replayEvery && index % replayEvery === 0) await send(index, true);
      }
    }
    await Promise.all(Array.from({ length: Math.min(count, concurrency) }, () => worker()));
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const committedRows = await workloadDb.query('SELECT count(*)::int AS count FROM orders');
    const summary = {
      scenario: 'bounded-local-http-checkout',
      variantMode,
      ordersPlanned: count,
      concurrency,
      replayEvery,
      ...result,
      committedOrders: committedRows[0].count,
      elapsedSeconds: Math.round(elapsedSeconds * 100) / 100,
      requestThroughputPerSecond: Math.round((latencies.length / elapsedSeconds) * 100) / 100,
      committedOrdersPerSecond: Math.round((committedRows[0].count / elapsedSeconds) * 100) / 100,
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (result.errors > 0 || committedRows[0].count !== result.success) {
      process.exitCode = 1;
    }
  } finally {
    if (app) await app.close();
    if (workloadDb?.isInitialized) await workloadDb.destroy();
    if (created) await controlDb.query(`DROP DATABASE IF EXISTS "${temporaryName}" WITH (FORCE)`);
    if (controlDb.isInitialized) await controlDb.destroy();
  }
}

await main();
