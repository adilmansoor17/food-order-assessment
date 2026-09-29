import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import { randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { HttpErrorFilter } from '../src/middlewares/http-exception.filter.js';
import { OtpDeliveryService } from '../src/services/otp-delivery.service.js';
import { FulfillmentService } from '../src/services/fulfillment.service.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const testDatabaseName = `food_ordering_test_http_${randomUUID().slice(0, 8)}`;
const migration = new URL('../migrations/001_initial.sql', import.meta.url);
const fulfillmentMigration = new URL('../migrations/002_fulfillment.sql', import.meta.url);
const adminOrderIndexMigration = new URL('../migrations/003_order_admin_index.sql', import.meta.url);
const simulatedPaymentsMigration = new URL('../migrations/004_simulated_payments.sql', import.meta.url);
const previousEnv = new Map<string, string | undefined>();
let controlDb: DataSource;
let testDb: DataSource;
let app: INestApplication;

function setEnv(key: string, value: string): void {
  if (!previousEnv.has(key)) previousEnv.set(key, process.env[key]);
  process.env[key] = value;
}

function testUrl(): string {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for HTTP end-to-end tests');
  const parsed = new URL(TEST_DATABASE_URL);
  if (!decodeURIComponent(parsed.pathname.slice(1)).toLowerCase().includes('test')) {
    throw new Error('TEST_DATABASE_URL must name a dedicated test database');
  }
  return TEST_DATABASE_URL;
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function refreshCookie(header: unknown): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') throw new Error('Expected a refresh cookie');
  return raw.split(';')[0];
}

beforeAll(async () => {
  const url = testUrl();
  controlDb = new DataSource({ type: 'postgres', url, synchronize: false });
  await controlDb.initialize();
  await controlDb.query(`CREATE DATABASE "${testDatabaseName}"`);
  const isolated = new URL(url);
  isolated.pathname = `/${testDatabaseName}`;
  testDb = new DataSource({ type: 'postgres', url: isolated.toString(), synchronize: false });
  await testDb.initialize();
  await testDb.query(await readFile(migration, 'utf8'));
  await testDb.query(await readFile(fulfillmentMigration, 'utf8'));
  await testDb.query(await readFile(adminOrderIndexMigration, 'utf8'));
  await testDb.query(await readFile(simulatedPaymentsMigration, 'utf8'));

  setEnv('NODE_ENV', 'test');
  setEnv('DB_HOST', isolated.hostname);
  setEnv('DB_PORT', isolated.port || '5432');
  setEnv('DB_USER', decodeURIComponent(isolated.username));
  setEnv('DB_PASSWORD', decodeURIComponent(isolated.password));
  setEnv('DB_NAME', testDatabaseName);
  setEnv('JWT_ACCESS_SECRET', 'http-e2e-access-secret-with-enough-entropy');
  setEnv('JWT_REFRESH_SECRET', 'http-e2e-refresh-secret-with-enough-entropy');
  setEnv('OTP_PEPPER', 'http-e2e-otp-pepper-with-enough-entropy');
  setEnv('OTP_ENCRYPTION_KEY', Buffer.alloc(32, 11).toString('base64'));
  setEnv('AUTH_TOKEN_HASH_SECRET', 'http-e2e-token-hash-secret-with-enough-entropy');
  setEnv('OTP_DELIVERY_MODE', 'test');
  setEnv('DEMO_PAYMENTS_ENABLED', 'true');
  setEnv('REDIS_URL', 'redis://127.0.0.1:1');
  setEnv('WEB_ORIGIN', 'http://localhost:3000');

  const { AppModule } = await import('../src/routes/app.module.js');
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('v1');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
}, 30_000);

afterAll(async () => {
  if (app) await app.close();
  if (testDb?.isInitialized) await testDb.destroy();
  if (controlDb?.isInitialized) {
    await controlDb.query(`DROP DATABASE IF EXISTS "${testDatabaseName}" WITH (FORCE)`);
    await controlDb.destroy();
  }
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}, 30_000);

describe('HTTP food ordering flow', () => {
  it('advertises the simulated payment option only when enabled', async () => {
    const response = await request(app.getHttpServer()).get('/v1/config/checkout').expect(200);
    expect(response.body).toMatchObject({ currency: 'PKR', demoPaymentsEnabled: true });
  });

  it('documents bearer access and required checkout/cart headers', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build());
    const checkout = document.paths['/v1/orders']?.post;
    const cartPut = document.paths['/v1/cart/items/{variantId}']?.put;
    expect(checkout?.security).toContainEqual({ bearer: [] });
    expect(document.paths['/v1/me']?.get?.security).toContainEqual({ bearer: [] });
    expect(document.paths['/v1/admin/products']?.post?.security).toContainEqual({ bearer: [] });
    expect(cartPut?.security).toContainEqual({ bearer: [] });
    expect(cartPut?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'if-match', in: 'header', required: true }),
    ]));
    for (const name of ['idempotency-key', 'if-match']) {
      expect(checkout?.parameters?.filter((parameter) =>
        'name' in parameter && parameter.in === 'header' && parameter.required === true && parameter.name.toLowerCase() === name,
      )).toHaveLength(1);
    }
    expect(cartPut?.parameters?.filter((parameter) =>
      'name' in parameter && parameter.in === 'header' && parameter.name.toLowerCase() === 'if-match',
    )).toHaveLength(1);
  });

  it('publishes typed success and safe error bodies for every HTTP operation', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build());
    for (const [path, item] of Object.entries(document.paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const operation = item?.[method];
        if (!operation) continue;
        const success = Object.entries(operation.responses).filter(([status]) => /^2\d\d$/.test(status));
        expect(success.length, `${method.toUpperCase()} ${path} has a success response`).toBeGreaterThan(0);
        for (const [status, response] of success) {
          if (status === '204') continue;
          expect(response, `${method.toUpperCase()} ${path} ${status}`).toHaveProperty(
            'content.application/json.schema.$ref',
          );
        }
        expect(operation.responses.default, `${method.toUpperCase()} ${path} default error`).toHaveProperty(
          'content.application/json.schema.$ref', '#/components/schemas/ApiErrorDto',
        );
      }
    }
    const schemas = document.components?.schemas as Record<string, { properties?: Record<string, unknown> }>;
    expect(schemas.OrderViewDto.properties).toMatchObject({
      totalMinor: { type: 'integer' },
      paymentType: { enum: ['cod', 'bank_transfer', 'demo'] },
      items: { type: 'array' },
    });
    expect(schemas.SessionDto.properties).toHaveProperty('user.$ref', '#/components/schemas/PublicUserDto');
    expect(schemas.SessionDto.properties).not.toHaveProperty('refreshToken');
    expect(schemas.PublicUserDto.properties).not.toHaveProperty('password_hash');
    expect(schemas.PublicProductDto.properties).not.toHaveProperty('stock');
    expect(schemas.PublicVariantDto.properties).not.toHaveProperty('sku');
  });

  it('rejects cross-origin auth requests before they can set a session or send an OTP', async () => {
    const hostileOrigin = 'https://attacker.example';
    await request(app.getHttpServer()).post('/v1/auth/register')
      .set('Origin', hostileOrigin)
      .send({ name: 'Injected Account', email: `csrf-${randomUUID()}@example.invalid`, phone: '+923001234570', password: 'CustomerPass123!' })
      .expect(403);
    await request(app.getHttpServer()).post('/v1/auth/login')
      .set('Origin', hostileOrigin)
      .send({ identifier: 'unknown@example.invalid', password: 'CustomerPass123!' })
      .expect(403);
    await request(app.getHttpServer()).post('/v1/auth/otp/request')
      .set('Origin', hostileOrigin)
      .send({ identifier: 'unknown@example.invalid', channel: 'email' })
      .expect(403);
    await request(app.getHttpServer()).post('/v1/auth/otp/verify')
      .set('Origin', hostileOrigin)
      .send({ challengeId: randomUUID(), code: '123456' })
      .expect(403);
  });

  it('rotates refresh cookies, revokes the family on replay, and clears it on logout', async () => {
    const email = `session-${randomUUID()}@example.invalid`;
    const phone = `+923${String(randomInt(1_000_000_000)).padStart(9, '0')}`;
    const password = 'SessionPassword123!';
    const registered = await request(app.getHttpServer()).post('/v1/auth/register')
      .send({ name: 'Session Customer', email, phone, password }).expect(201);
    const firstCookie = refreshCookie(registered.headers['set-cookie']);
    expect(firstCookie).toMatch(/^fo_refresh=/);

    const rotated = await request(app.getHttpServer()).post('/v1/auth/refresh')
      .set('Cookie', firstCookie).expect(200);
    const secondCookie = refreshCookie(rotated.headers['set-cookie']);
    expect(secondCookie).toMatch(/^fo_refresh=/);
    expect(secondCookie).not.toBe(firstCookie);
    await request(app.getHttpServer()).get('/v1/me')
      .set('Authorization', bearer(rotated.body.accessToken as string)).expect(200);

    await request(app.getHttpServer()).post('/v1/auth/refresh')
      .set('Cookie', firstCookie).expect(401);
    await request(app.getHttpServer()).post('/v1/auth/refresh')
      .set('Cookie', secondCookie).expect(401);
    await request(app.getHttpServer()).get('/v1/me')
      .set('Authorization', bearer(rotated.body.accessToken as string)).expect(401);

    const login = await request(app.getHttpServer()).post('/v1/auth/login')
      .send({ identifier: phone, password }).expect(200);
    const loginCookie = refreshCookie(login.headers['set-cookie']);
    await request(app.getHttpServer()).post('/v1/auth/logout')
      .set('Cookie', loginCookie).expect(204);
    await request(app.getHttpServer()).post('/v1/auth/refresh')
      .set('Cookie', loginCookie).expect(401);
    await request(app.getHttpServer()).get('/v1/me')
      .set('Authorization', bearer(login.body.accessToken as string)).expect(401);
  });

  it('registers and logs in, manages a two-variant cart, checks out, and protects admin catalog writes', async () => {
    const customerEmail = `customer-${randomUUID()}@example.invalid`;
    const password = 'CustomerPass123!';
    const registration = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ name: 'HTTP Customer', email: customerEmail, phone: '+923001234567', password })
      .expect(201);
    expect(registration.body.user).toMatchObject({ email: customerEmail, role: 'customer' });
    expect(registration.body.accessToken).toEqual(expect.any(String));
    await request(app.getHttpServer()).get('/v1/me').expect(401);

    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ identifier: customerEmail, password })
      .expect(200);
    const customerToken = login.body.accessToken as string;
    const me = await request(app.getHttpServer()).get('/v1/me').set('Authorization', bearer(customerToken)).expect(200);
    expect(me.body.email).toBe(customerEmail);

    const adminId = randomUUID();
    const adminEmail = `admin-${adminId}@example.invalid`;
    await testDb.query(
      `INSERT INTO users (id, name, email, phone_e164, password_hash, role, email_verified_at, phone_verified_at)
       VALUES ($1,$2,$3,$4,$5,'admin',now(),now())`,
      [adminId, 'HTTP Admin', adminEmail, '+923001234568', await bcrypt.hash('AdminPass123!', 10)],
    );
    const adminLogin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ identifier: adminEmail, password: 'AdminPass123!' })
      .expect(200);
    const adminToken = adminLogin.body.accessToken as string;

    await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('Authorization', bearer(adminToken))
      .send({ name: 'Too long', description: 'x'.repeat(2001), variants: [{ name: 'Regular', sku: `LONG-${randomUUID()}`, priceMinor: 1000, initialStock: 2 }] })
      .expect(400);
    await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('Authorization', bearer(adminToken))
      .send({ name: 'Too many', variants: Array.from({ length: 101 }, (_, index) => ({ name: 'Regular', sku: `MANY-${index}`, priceMinor: 1000, initialStock: 2 })) })
      .expect(400);

    await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('Authorization', bearer(customerToken))
      .send({ name: 'Forbidden', variants: [{ name: 'Regular', sku: 'FORBIDDEN', priceMinor: 1000, initialStock: 2 }] })
      .expect(403);
    const created = await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('Authorization', bearer(adminToken))
      .send({
        name: 'HTTP Burger',
        description: 'Test item',
        variants: [
          { name: 'Regular', sku: `REG-${randomUUID()}`, priceMinor: 1000, initialStock: 10 },
          { name: 'Large', sku: `LRG-${randomUUID()}`, priceMinor: 1500, initialStock: 10 },
        ],
      })
      .expect(201);
    const productId = created.body.id as string;
    const regularId = created.body.variants.find((variant: { name: string }) => variant.name === 'Regular').id as string;
    const largeId = created.body.variants.find((variant: { name: string }) => variant.name === 'Large').id as string;
    const catalog = await request(app.getHttpServer()).get('/v1/products').expect(200);
    expect(catalog.body.items.some((item: { id: string }) => item.id === productId)).toBe(true);
    const publicProduct = catalog.body.items.find((item: { id: string }) => item.id === productId);
    expect(Object.keys(publicProduct).sort()).toEqual(['description', 'id', 'name', 'variants']);
    expect(Object.keys(publicProduct.variants[0]).sort()).toEqual(['available', 'currency', 'id', 'name', 'priceMinor']);
    expect(publicProduct.variants[0].available).toBe(true);
    expect(created.body.variants[0]).toHaveProperty('stock', 10);
    const updated = await request(app.getHttpServer())
      .patch(`/v1/admin/products/${productId}`)
      .set('Authorization', bearer(adminToken))
      .send({ name: 'HTTP Burger Updated' })
      .expect(200);
    expect(updated.body.name).toBe('HTTP Burger Updated');
    const detail = await request(app.getHttpServer()).get(`/v1/products/${productId}`).expect(200);
    expect(detail.body.variants).toHaveLength(2);
    expect(Object.keys(detail.body).sort()).toEqual(['description', 'id', 'name', 'variants']);

    const initialCart = await request(app.getHttpServer()).get('/v1/cart').set('Authorization', bearer(customerToken)).expect(200);
    expect(initialCart.body).toMatchObject({ version: 0, totalMinor: 0 });
    await request(app.getHttpServer())
      .put(`/v1/cart/items/${regularId}`).set('Authorization', bearer(customerToken)).set('If-Match', '0')
      .send({ quantity: 1, userId: adminId }).expect(400);
    const addRegular = await request(app.getHttpServer())
      .put(`/v1/cart/items/${regularId}`).set('Authorization', bearer(customerToken)).set('If-Match', '0')
      .send({ quantity: 1 }).expect(200);
    expect(addRegular.body).toMatchObject({ version: 1, totalMinor: 1000 });
    expect(addRegular.body.items[0]).not.toHaveProperty('stock');
    const updateRegular = await request(app.getHttpServer())
      .put(`/v1/cart/items/${regularId}`).set('Authorization', bearer(customerToken)).set('If-Match', '1')
      .send({ quantity: 2 }).expect(200);
    expect(updateRegular.body).toMatchObject({ version: 2, totalMinor: 2000 });
    const addLarge = await request(app.getHttpServer())
      .put(`/v1/cart/items/${largeId}`).set('Authorization', bearer(customerToken)).set('If-Match', '2')
      .send({ quantity: 1 }).expect(200);
    expect(addLarge.body).toMatchObject({ version: 3, totalMinor: 3500 });
    expect(addLarge.body.items).toHaveLength(2);
    const removed = await request(app.getHttpServer())
      .delete(`/v1/cart/items/${largeId}`).set('Authorization', bearer(customerToken)).set('If-Match', '3').expect(200);
    expect(removed.body).toMatchObject({ version: 4, totalMinor: 2000 });
    const noOpRemove = await request(app.getHttpServer())
      .delete(`/v1/cart/items/${largeId}`).set('Authorization', bearer(customerToken)).set('If-Match', '4').expect(200);
    expect(noOpRemove.body).toMatchObject({ version: 4, totalMinor: 2000 });
    const restored = await request(app.getHttpServer())
      .put(`/v1/cart/items/${largeId}`).set('Authorization', bearer(customerToken)).set('If-Match', '4')
      .send({ quantity: 1 }).expect(200);
    expect(restored.body).toMatchObject({ version: 5, totalMinor: 3500 });

    const key = randomUUID();
    const checkedOut = await request(app.getHttpServer())
      .post('/v1/orders').set('Authorization', bearer(customerToken))
      .set('Idempotency-Key', key).set('If-Match', '5')
      .send({ paymentType: 'cod', expectedTotalMinor: 3500 }).expect(201);
    expect(checkedOut.body).toMatchObject({ status: 'pending', paymentType: 'cod', totalMinor: 3500 });
    expect(checkedOut.body.items).toHaveLength(2);
    const orderId = checkedOut.body.id as string;
    const replay = await request(app.getHttpServer())
      .post('/v1/orders').set('Authorization', bearer(customerToken))
      .set('Idempotency-Key', key).set('If-Match', '5')
      .send({ paymentType: 'cod', expectedTotalMinor: 3500 }).expect(201);
    expect(replay.body).toEqual(checkedOut.body);
    const orderStatus = await request(app.getHttpServer())
      .get(`/v1/orders/${orderId}/status`).set('Authorization', bearer(customerToken)).expect(200);
    expect(orderStatus.body).toMatchObject({ status: 'pending', fulfillmentStatus: 'queued' });
    const processEvent = await testDb.query("SELECT id FROM outbox WHERE aggregate_id = $1 AND event_type = 'order.process'", [orderId]) as { id: string }[];
    await new FulfillmentService(testDb).process(processEvent[0].id, orderId);
    const paid = await request(app.getHttpServer())
      .post(`/v1/admin/orders/${orderId}/mark-paid`).set('Authorization', bearer(adminToken)).expect(201);
    expect(paid.body).toMatchObject({ status: 'paid', paymentStatus: 'paid' });
    const orderList = await request(app.getHttpServer()).get('/v1/orders').set('Authorization', bearer(customerToken)).expect(200);
    expect(orderList.body.items.some((item: { id: string; status: string }) => item.id === orderId && item.status === 'paid')).toBe(true);

    const otherId = randomUUID();
    const otherEmail = `other-${otherId}@example.invalid`;
    await testDb.query(
      `INSERT INTO users (id, name, email, phone_e164, password_hash) VALUES ($1,$2,$3,$4,$5)`,
      [otherId, 'Other Customer', otherEmail, '+923001234571', await bcrypt.hash('OtherPass123!', 10)],
    );
    const otherLogin = await request(app.getHttpServer()).post('/v1/auth/login')
      .send({ identifier: otherEmail, password: 'OtherPass123!' }).expect(200);
    const otherToken = otherLogin.body.accessToken as string;
    const otherCart = await request(app.getHttpServer()).get('/v1/cart').set('Authorization', bearer(otherToken)).expect(200);
    expect(otherCart.body).toMatchObject({ userId: otherId, items: [] });
    const otherOrders = await request(app.getHttpServer()).get('/v1/orders').set('Authorization', bearer(otherToken)).expect(200);
    expect(otherOrders.body.items).toEqual([]);
    await request(app.getHttpServer()).get(`/v1/orders/${orderId}`).set('Authorization', bearer(otherToken)).expect(404);
    await request(app.getHttpServer()).get(`/v1/orders/${orderId}/status`).set('Authorization', bearer(otherToken)).expect(404);
    await request(app.getHttpServer()).put(`/v1/orders/${orderId}/transfer-reference`)
      .set('Authorization', bearer(otherToken)).send({ reference: 'NOT-MINE' }).expect(404);

    const archived = await request(app.getHttpServer())
      .delete(`/v1/admin/products/${productId}`).set('Authorization', bearer(adminToken)).expect(200);
    expect(archived.body.active).toBe(false);
    await request(app.getHttpServer())
      .delete(`/v1/admin/products/${productId}`).set('Authorization', bearer(adminToken)).expect(200);
    await request(app.getHttpServer()).get(`/v1/products/${productId}`).expect(404);
    const audits = await testDb.query("SELECT count(*)::int AS count FROM admin_audit WHERE target_id = $1 AND action = 'product.archive'", [productId]) as { count: number }[];
    expect(audits[0].count).toBe(1);

    await testDb.query('UPDATE users SET status = $2 WHERE id = $1', [registration.body.user.id, 'disabled']);
    await request(app.getHttpServer()).get('/v1/me').set('Authorization', bearer(customerToken)).expect(401);
    await request(app.getHttpServer()).get('/v1/cart').set('Authorization', bearer(customerToken)).expect(401);
    await testDb.query('UPDATE users SET role = $2 WHERE id = $1', [adminId, 'customer']);
    await request(app.getHttpServer()).get('/v1/admin/products').set('Authorization', bearer(adminToken)).expect(403);
    await request(app.getHttpServer()).post(`/v1/admin/orders/${orderId}/mark-paid`)
      .set('Authorization', bearer(adminToken)).expect(403);
  }, 30_000);

  it('requests and verifies a login OTP through the test delivery adapter, then rejects replay', async () => {
    const email = `otp-${randomUUID()}@example.invalid`;
    await request(app.getHttpServer()).post('/v1/auth/register')
      .send({ name: 'OTP Customer', email, phone: '+923001234569', password: 'OtpPassword123!' }).expect(201);
    const requested = await request(app.getHttpServer()).post('/v1/auth/otp/request')
      .send({ identifier: email, channel: 'email' }).expect(202);
    const challengeId = requested.body.challengeId as string;
    const delivery = app.get(OtpDeliveryService);
    await delivery.deliverChallenge(challengeId);
    const code = delivery.readTestMessage(email);
    expect(code).toMatch(/^\d{6}$/);
    const verified = await request(app.getHttpServer()).post('/v1/auth/otp/verify')
      .send({ challengeId, code }).expect(200);
    expect(verified.body.accessToken).toEqual(expect.any(String));
    await request(app.getHttpServer()).post('/v1/auth/otp/verify')
      .send({ challengeId, code }).expect(401);
  }, 20_000);

  it('delivers a phone login OTP through the test adapter and rejects wrong and replayed codes', async () => {
    const email = `phone-otp-${randomUUID()}@example.invalid`;
    const phone = `+923${String(randomInt(1_000_000_000)).padStart(9, '0')}`;
    await request(app.getHttpServer()).post('/v1/auth/register')
      .send({ name: 'Phone OTP Customer', email, phone, password: 'PhoneOtpPassword123!' }).expect(201);
    const requested = await request(app.getHttpServer()).post('/v1/auth/otp/request')
      .send({ identifier: phone, channel: 'phone' }).expect(202);
    const challengeId = requested.body.challengeId as string;
    const delivery = app.get(OtpDeliveryService);
    await delivery.deliverChallenge(challengeId);
    const code = delivery.readTestMessage(phone);
    expect(code).toMatch(/^\d{6}$/);
    const wrongCode = code === '000000' ? '000001' : '000000';
    await request(app.getHttpServer()).post('/v1/auth/otp/verify')
      .send({ challengeId, code: wrongCode }).expect(401);
    const verified = await request(app.getHttpServer()).post('/v1/auth/otp/verify')
      .send({ challengeId, code }).expect(200);
    expect(verified.body.user).toMatchObject({ email, phone });
    expect(verified.body.accessToken).toEqual(expect.any(String));
    await request(app.getHttpServer()).post('/v1/auth/otp/verify')
      .send({ challengeId, code }).expect(401);
  }, 20_000);

  it('returns Retry-After when passwordless login requests exceed the identity limit', async () => {
    const identifier = `rate-${randomUUID()}@example.invalid`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app.getHttpServer()).post('/v1/auth/otp/request')
        .send({ identifier, channel: 'email' }).expect(202);
    }
    const limited = await request(app.getHttpServer()).post('/v1/auth/otp/request')
      .send({ identifier, channel: 'email' }).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });
  });
});
