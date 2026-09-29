import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../src/models/user.types.js';
import { BrokerService } from '../src/services/broker.service.js';
import { NotificationConsumerService } from '../src/services/notification-consumer.service.js';
import { OrderProcessingConsumerService } from '../src/services/order-processing-consumer.service.js';
import { OrderEmailService } from '../src/services/order-email.service.js';
import { OrdersService } from '../src/services/orders.service.js';
import { FulfillmentService } from '../src/services/fulfillment.service.js';
import { OutboxRelayService } from '../src/services/outbox-relay.service.js';
import type { OtpDeliveryService } from '../src/services/otp-delivery.service.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const schema = `order_test_${randomUUID().replaceAll('-', '')}`;
const migration = new URL('../migrations/001_initial.sql', import.meta.url);
const fulfillmentMigration = new URL('../migrations/002_fulfillment.sql', import.meta.url);
const adminIndexMigration = new URL('../migrations/003_order_admin_index.sql', import.meta.url);
const simulatedPaymentsMigration = new URL('../migrations/004_simulated_payments.sql', import.meta.url);
let adminDb: DataSource;
let db: DataSource;
let orders: OrdersService;
let phoneSequence = 0;

function requireTestDatabaseUrl(): string {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for the real PostgreSQL end-to-end suite');
  const parsed = new URL(TEST_DATABASE_URL);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!databaseName.toLowerCase().includes('test')) {
    throw new Error('TEST_DATABASE_URL must name a dedicated test database');
  }
  return TEST_DATABASE_URL;
}

async function seedUser(role: 'customer' | 'admin' = 'customer'): Promise<AuthUser> {
  const id = randomUUID();
  phoneSequence += 1;
  await db.query(
    `INSERT INTO users (id, name, email, phone_e164, password_hash, role, email_verified_at, phone_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,now(),now())`,
    [id, 'Test Customer', `test-${id}@example.invalid`, `+9230000${String(phoneSequence).padStart(5, '0')}`, 'test-only', role],
  );
  return { id, role, sessionId: randomUUID() };
}

async function seedCart(userId: string, stock: number, priceMinor = 1250, quantity = 1) {
  const productId = randomUUID();
  const variantId = randomUUID();
  const cartId = randomUUID();
  await db.query('INSERT INTO products (id, name) VALUES ($1,$2)', [productId, 'Integration Burger']);
  await db.query(
    'INSERT INTO variants (id, product_id, name, sku, price_minor, stock) VALUES ($1,$2,$3,$4,$5,$6)',
    [variantId, productId, 'Large', `SKU-${variantId}`, priceMinor, stock],
  );
  await db.query('INSERT INTO carts (id, user_id) VALUES ($1,$2)', [cartId, userId]);
  await db.query('INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1,$2,$3)', [cartId, variantId, quantity]);
  return { productId, variantId, cartId };
}

async function addCartForVariant(userId: string, variantId: string, quantity = 1) {
  const cartId = randomUUID();
  await db.query('INSERT INTO carts (id, user_id) VALUES ($1,$2)', [cartId, userId]);
  await db.query('INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1,$2,$3)', [cartId, variantId, quantity]);
}

beforeAll(async () => {
  const url = requireTestDatabaseUrl();
  adminDb = new DataSource({ type: 'postgres', url, synchronize: false });
  await adminDb.initialize();
  const setup = adminDb.createQueryRunner();
  await setup.connect();
  try {
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.query(`SET search_path TO "${schema}"`);
    await setup.query(await readFile(migration, 'utf8'));
    await setup.query(await readFile(fulfillmentMigration, 'utf8'));
    await setup.query(await readFile(adminIndexMigration, 'utf8'));
    await setup.query(await readFile(simulatedPaymentsMigration, 'utf8'));
  } finally {
    await setup.release();
  }
  db = new DataSource({ type: 'postgres', url, schema, extra: { options: `-c search_path=${schema}` }, synchronize: false });
  await db.initialize();
  const current = await db.query('SELECT current_schema() AS name') as { name: string }[];
  if (current[0]?.name !== schema) throw new Error('Test database did not select its isolated schema');
  orders = new OrdersService(db);
}, 30_000);

afterAll(async () => {
  if (db?.isInitialized) await db.destroy();
  if (adminDb?.isInitialized) {
    await adminDb.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminDb.destroy();
  }
}, 30_000);

describe('orders against real PostgreSQL', () => {
  it('pages the recent admin list across users while customer lists stay owner-scoped', async () => {
    const firstCustomer = await seedUser();
    const secondCustomer = await seedUser();
    await seedCart(firstCustomer.id, 2);
    await seedCart(secondCustomer.id, 2);
    const first = await orders.checkout(firstCustomer, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
    const second = await orders.checkout(secondCustomer, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 });

    const customerPage = await orders.list(firstCustomer);
    expect(customerPage.items.map((order) => order.id)).toContain(first.id);
    expect(customerPage.items.map((order) => order.id)).not.toContain(second.id);

    const adminFirst = await orders.listAdmin(undefined, '1');
    expect(adminFirst.items).toHaveLength(1);
    const nextCursor = adminFirst.nextCursor;
    expect(nextCursor).toEqual(expect.any(String));
    if (!nextCursor) throw new Error('Expected a second admin order page');
    const adminNext = await orders.listAdmin(nextCursor, '100');
    const visible = new Set([...adminFirst.items, ...adminNext.items].map((order) => order.id));
    expect(visible.has(first.id)).toBe(true);
    expect(visible.has(second.id)).toBe(true);
  });

  it('commits one priced order and outbox event, then replays the original response after clearing the cart', async () => {
    const customer = await seedUser();
    const { variantId, cartId } = await seedCart(customer.id, 10, 1250, 2);
    const key = randomUUID();
    const first = await orders.checkout(customer, key, '0', { paymentType: 'cod', expectedTotalMinor: 2500 });
    const replay = await orders.checkout(customer, key, '0', { paymentType: 'cod', expectedTotalMinor: 2500 });

    expect(first).toEqual(replay);
    expect(first).toMatchObject({ status: 'pending', paymentStatus: 'pending', totalMinor: 2500 });
    expect(first.items).toHaveLength(1);
    const stock = await db.query('SELECT stock FROM variants WHERE id = $1', [variantId]) as { stock: number }[];
    const cart = await db.query('SELECT version FROM carts WHERE id = $1', [cartId]) as { version: number }[];
    const items = await db.query('SELECT count(*)::int AS count FROM cart_items WHERE cart_id = $1', [cartId]) as { count: number }[];
    const persisted = await db.query('SELECT count(*)::int AS count FROM orders WHERE id = $1', [first.id]) as { count: number }[];
    const outbox = await db.query("SELECT count(*)::int AS count FROM outbox WHERE aggregate_id = $1 AND event_type = 'order.placed'", [first.id]) as { count: number }[];
    expect({ stock: stock[0].stock, cartVersion: cart[0].version, cartItems: items[0].count, orders: persisted[0].count, events: outbox[0].count })
      .toEqual({ stock: 8, cartVersion: 1, cartItems: 0, orders: 1, events: 1 });
    await expect(orders.checkout(customer, key, '0', { paymentType: 'cod', expectedTotalMinor: 2600 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('allows only one concurrent checkout for the last unit of stock', async () => {
    const first = await seedUser();
    const second = await seedUser();
    const { variantId } = await seedCart(first.id, 1);
    await addCartForVariant(second.id, variantId);
    const results = await Promise.allSettled([
      orders.checkout(first, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 }),
      orders.checkout(second, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const stock = await db.query('SELECT stock FROM variants WHERE id = $1', [variantId]) as { stock: number }[];
    const sold = await db.query('SELECT count(*)::int AS count FROM order_items WHERE variant_id = $1', [variantId]) as { count: number }[];
    expect(stock[0].stock).toBe(0);
    expect(sold[0].count).toBe(1);
  });

  it('requires a transfer reference before admin settlement and keeps customer ownership private', async () => {
    const customer = await seedUser();
    const other = await seedUser();
    const admin = await seedUser('admin');
    await seedCart(customer.id, 2);
    const order = await orders.checkout(customer, randomUUID(), '0', { paymentType: 'bank_transfer', expectedTotalMinor: 1250 });
    await expect(orders.get(other, order.id)).rejects.toMatchObject({ status: 404 });
    await expect(orders.markPaid(admin, order.id)).rejects.toMatchObject({ status: 409 });
    const withReference = await orders.updateTransferReference(customer, order.id, 'BANK-REF-123');
    expect(withReference.transferReference).toBe('BANK-REF-123');
    const processEvent = await db.query("SELECT id FROM outbox WHERE aggregate_id = $1 AND event_type = 'order.process'", [order.id]) as { id: string }[];
    await new FulfillmentService(db).process(processEvent[0].id, order.id);
    const paid = await orders.markPaid(admin, order.id);
    expect(paid).toMatchObject({ status: 'paid', paymentStatus: 'paid', paidAt: expect.any(String) });
    expect((await orders.status(customer, order.id)).status).toBe('paid');
    await orders.markPaid(admin, order.id);
    const audit = await db.query("SELECT count(*)::int AS count FROM admin_audit WHERE target_id = $1 AND action = 'order.mark_paid'", [order.id]) as { count: number }[];
    expect(audit[0].count).toBe(1);
    await expect(orders.cancel(admin, order.id)).rejects.toMatchObject({ status: 409 });
  });

  it('restores stock once when an admin cancels a pending order', async () => {
    const customer = await seedUser();
    const admin = await seedUser('admin');
    const { variantId } = await seedCart(customer.id, 2);
    const order = await orders.checkout(customer, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
    expect((await orders.cancel(admin, order.id)).status).toBe('cancelled');
    expect((await orders.cancel(admin, order.id)).status).toBe('cancelled');
    const stock = await db.query('SELECT stock FROM variants WHERE id = $1', [variantId]) as { stock: number }[];
    const audit = await db.query("SELECT count(*)::int AS count FROM admin_audit WHERE target_id = $1 AND action = 'order.cancel'", [order.id]) as { count: number }[];
    expect(stock[0].stock).toBe(2);
    expect(audit[0].count).toBe(1);
  });

  it.skipIf(!process.env.TEST_RABBITMQ_URL)('relays a committed outbox event through real RabbitMQ and records consumer dedupe', async () => {
    const testBrokerUrl = process.env.TEST_RABBITMQ_URL!;
    const parsedBrokerUrl = new URL(testBrokerUrl);
    const host = parsedBrokerUrl.hostname;
    if (!['localhost', '127.0.0.1', 'rabbitmq'].includes(host)) throw new Error('TEST_RABBITMQ_URL must target a local test broker');
    if (!decodeURIComponent(parsedBrokerUrl.pathname.slice(1)).toLowerCase().includes('test')) {
      throw new Error('TEST_RABBITMQ_URL must select an isolated test vhost');
    }
    const previousBrokerUrl = process.env.RABBITMQ_URL;
    const previousDeliveryMode = process.env.OTP_DELIVERY_MODE;
    process.env.RABBITMQ_URL = testBrokerUrl;
    process.env.OTP_DELIVERY_MODE = 'test';
    const broker = new BrokerService();
    let consumer: NotificationConsumerService | undefined;
    let orderConsumer: OrderProcessingConsumerService | undefined;
    try {
      const customer = await seedUser();
      await seedCart(customer.id, 2);
      const order = await orders.checkout(customer, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
      const events = await db.query("SELECT id FROM outbox WHERE aggregate_id = $1 AND event_type = 'order.placed'", [order.id]) as { id: string }[];
      const processEvents = await db.query("SELECT id FROM outbox WHERE aggregate_id = $1 AND event_type = 'order.process'", [order.id]) as { id: string }[];
      // Prior test cases created outbox rows in this schema without running a
      // worker. Keep this broker assertion scoped to its own live order.
      await db.query("UPDATE outbox SET status = 'sent' WHERE aggregate_id <> $1", [order.id]);
      await broker.channel();
      const relay = new OutboxRelayService(db, broker);
      await relay.dispatch();
      const email = new OrderEmailService();
      consumer = new NotificationConsumerService(db, broker, { deliverChallenge: vi.fn() } as unknown as OtpDeliveryService, email);
      orderConsumer = new OrderProcessingConsumerService(broker, new FulfillmentService(db));
      consumer.onModuleInit();
      orderConsumer.onModuleInit();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const done = await db.query(
          'SELECT consumer FROM consumer_dedupe WHERE event_id IN ($1,$2)',
          [events[0].id, processEvents[0].id],
        ) as { consumer: string }[];
        if (done.some((item) => item.consumer === 'notifications') && done.some((item) => item.consumer === 'fulfillment')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const done = await db.query('SELECT 1 FROM consumer_dedupe WHERE event_id = $1 AND consumer = $2', [events[0].id, 'notifications']) as unknown[];
      const processDone = await db.query('SELECT 1 FROM consumer_dedupe WHERE event_id = $1 AND consumer = $2', [processEvents[0].id, 'fulfillment']) as unknown[];
      expect(done).toHaveLength(1);
      expect(processDone).toHaveLength(1);
      expect(email.testDeliveries.some((delivery) => delivery.eventId === events[0].id)).toBe(true);
    } finally {
      if (orderConsumer) await orderConsumer.onModuleDestroy();
      if (consumer) await consumer.onModuleDestroy();
      await broker.onModuleDestroy();
      if (previousBrokerUrl === undefined) delete process.env.RABBITMQ_URL;
      else process.env.RABBITMQ_URL = previousBrokerUrl;
      if (previousDeliveryMode === undefined) delete process.env.OTP_DELIVERY_MODE;
      else process.env.OTP_DELIVERY_MODE = previousDeliveryMode;
    }
  }, 20_000);
});
