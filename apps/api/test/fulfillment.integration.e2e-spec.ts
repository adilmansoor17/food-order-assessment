import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../src/models/user.types.js';
import {
  BrokerService,
  DEAD_EXCHANGE,
  EVENTS_EXCHANGE,
  ORDER_DEAD_ROUTING_KEY,
  ORDER_DEAD_QUEUE,
  ORDER_MAIN_QUEUE,
  ORDER_RETRY_QUEUE,
  ORDER_RETRY_ROUTING_KEY,
  ORDER_ROUTING_KEY,
  RETRY_EXCHANGE,
} from '../src/services/broker.service.js';
import { DemoPaymentProductionError, FulfillmentService } from '../src/services/fulfillment.service.js';
import { OrderProcessingConsumerService } from '../src/services/order-processing-consumer.service.js';
import { OrdersService } from '../src/services/orders.service.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const schema = `fulfillment_test_${randomUUID().replaceAll('-', '')}`;
const initialMigration = new URL('../migrations/001_initial.sql', import.meta.url);
const fulfillmentMigration = new URL('../migrations/002_fulfillment.sql', import.meta.url);
const adminIndexMigration = new URL('../migrations/003_order_admin_index.sql', import.meta.url);
const simulatedPaymentsMigration = new URL('../migrations/004_simulated_payments.sql', import.meta.url);
let adminDb: DataSource;
let db: DataSource;
let orders: OrdersService;
let fulfillment: FulfillmentService;
let legacyOrderId: string;
let sequence = 0;

function requireTestDatabaseUrl(): string {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for the real PostgreSQL fulfillment suite');
  const parsed = new URL(TEST_DATABASE_URL);
  if (!decodeURIComponent(parsed.pathname.slice(1)).toLowerCase().includes('test')) {
    throw new Error('TEST_DATABASE_URL must name a dedicated test database');
  }
  return TEST_DATABASE_URL;
}

async function seedUser(role: 'customer' | 'admin' = 'customer'): Promise<AuthUser> {
  const id = randomUUID();
  sequence += 1;
  await db.query(
    `INSERT INTO users (id, name, email, phone_e164, password_hash, role, email_verified_at, phone_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,now(),now())`,
    [id, 'Fulfillment Test', `fulfillment-${id}@example.invalid`, `+9231000${String(sequence).padStart(5, '0')}`, 'test-only', role],
  );
  return { id, role, sessionId: randomUUID() };
}

async function seedCart(userId: string, stock = 3) {
  const productId = randomUUID();
  const variantId = randomUUID();
  const cartId = randomUUID();
  await db.query('INSERT INTO products (id, name) VALUES ($1,$2)', [productId, 'Fulfillment Burger']);
  await db.query(
    'INSERT INTO variants (id, product_id, name, sku, price_minor, stock) VALUES ($1,$2,$3,$4,$5,$6)',
    [variantId, productId, 'Standard', `FUL-${variantId}`, 1250, stock],
  );
  await db.query('INSERT INTO carts (id, user_id) VALUES ($1,$2)', [cartId, userId]);
  await db.query('INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1,$2,$3)', [cartId, variantId, 1]);
  return { variantId };
}

async function processEventId(orderId: string): Promise<string> {
  const rows = await db.query(
    "SELECT id FROM outbox WHERE aggregate_id = $1 AND event_type = 'order.process'",
    [orderId],
  ) as { id: string }[];
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

async function fulfillmentState(orderId: string) {
  const rows = await db.query(
    `SELECT o.fulfillment_status AS public_status, t.status AS task_status,
            t.attempts, t.processed_at, t.failed_at, t.voided_at
       FROM orders o JOIN order_fulfillment_tasks t ON t.order_id = o.id
      WHERE o.id = $1`,
    [orderId],
  ) as {
    public_status: string;
    task_status: string;
    attempts: number;
    processed_at: Date | null;
    failed_at: Date | null;
    voided_at: Date | null;
  }[];
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for order-processing event');
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
    await setup.query(await readFile(initialMigration, 'utf8'));
    const legacyUserId = randomUUID();
    legacyOrderId = randomUUID();
    await setup.query(
      `INSERT INTO users (id, name, email, phone_e164, password_hash)
       VALUES ($1,$2,$3,$4,$5)`,
      [legacyUserId, 'Legacy Customer', `legacy-${legacyUserId}@example.invalid`, '+923100000000', 'test-only'],
    );
    await setup.query(
      'INSERT INTO orders (id, user_id, payment_type, total_minor) VALUES ($1,$2,$3,$4)',
      [legacyOrderId, legacyUserId, 'cod', 1250],
    );
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
  fulfillment = new FulfillmentService(db);
}, 30_000);

afterAll(async () => {
  if (db?.isInitialized) await db.destroy();
  if (adminDb?.isInitialized) {
    await adminDb.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminDb.destroy();
  }
}, 30_000);

describe('fulfillment migration and checkout durability', () => {
  it('keeps a pre-queue order ready after migration', async () => {
    const rows = await db.query(
      'SELECT fulfillment_status, fulfillment_updated_at FROM orders WHERE id = $1',
      [legacyOrderId],
    ) as { fulfillment_status: string; fulfillment_updated_at: Date }[];
    expect(rows[0]).toMatchObject({ fulfillment_status: 'ready', fulfillment_updated_at: expect.any(Date) });
  });

  it('commits exactly one queued task and process event with an idempotent checkout', async () => {
    const customer = await seedUser();
    const { variantId } = await seedCart(customer.id);
    const key = randomUUID();
    const first = await orders.checkout(customer, key, '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
    const replay = await orders.checkout(customer, key, '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
    expect(first).toEqual(replay);
    expect(first.fulfillmentStatus).toBe('queued');
    const tasks = await db.query(
      'SELECT status, snapshot, attempts FROM order_fulfillment_tasks WHERE order_id = $1',
      [first.id],
    ) as { status: string; snapshot: unknown; attempts: number }[];
    const events = await db.query(
      "SELECT count(*)::int AS count FROM outbox WHERE aggregate_id = $1 AND event_type = 'order.process'",
      [first.id],
    ) as { count: number }[];
    const stock = await db.query('SELECT stock FROM variants WHERE id = $1', [variantId]) as { stock: number }[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'queued', attempts: 0, snapshot: expect.any(Object) });
    expect(events[0].count).toBe(1);
    expect(stock[0].stock).toBe(2);
  });

  it('creates one simulated payment at checkout and settles it once with fulfillment', async () => {
    const previous = process.env.DEMO_PAYMENTS_ENABLED;
    process.env.DEMO_PAYMENTS_ENABLED = 'true';
    try {
      const customer = await seedUser();
      const admin = await seedUser('admin');
      await seedCart(customer.id);
      const key = randomUUID();
      const order = await orders.checkout(customer, key, '0', { paymentType: 'demo', expectedTotalMinor: 1250 });
      expect(order).toMatchObject({ status: 'pending', paymentStatus: 'pending', fulfillmentStatus: 'queued' });
      expect(await orders.checkout(customer, key, '0', { paymentType: 'demo', expectedTotalMinor: 1250 })).toEqual(order);
      const pending = await db.query('SELECT status, amount_minor, currency FROM simulated_payments WHERE order_id = $1', [order.id]) as
        { status: string; amount_minor: string; currency: string }[];
      expect(pending).toEqual([{ status: 'pending', amount_minor: '1250', currency: 'PKR' }]);
      await expect(orders.markPaid(admin, order.id)).rejects.toMatchObject({ status: 409 });

      const eventId = await processEventId(order.id);
      expect(await fulfillment.process(eventId, order.id)).toBe('ready');
      expect(await fulfillment.process(eventId, order.id)).toBe('already_ready');
      expect(await orders.get(customer, order.id)).toMatchObject({ status: 'paid', paymentStatus: 'paid', fulfillmentStatus: 'ready' });
      const settled = await db.query('SELECT status, settled_at FROM simulated_payments WHERE order_id = $1', [order.id]) as
        { status: string; settled_at: Date | null }[];
      expect(settled).toMatchObject([{ status: 'succeeded', settled_at: expect.any(Date) }]);
      const paidEvents = await db.query(
        "SELECT count(*)::int AS count FROM outbox WHERE aggregate_id = $1 AND event_type = 'order.paid'",
        [order.id],
      ) as { count: number }[];
      expect(paidEvents[0].count).toBe(1);
      expect(await orders.checkout(customer, key, '0', { paymentType: 'demo', expectedTotalMinor: 1250 })).toEqual(order);
      await expect(orders.cancel(admin, order.id)).rejects.toMatchObject({ status: 409 });
    } finally {
      if (previous === undefined) delete process.env.DEMO_PAYMENTS_ENABLED;
      else process.env.DEMO_PAYMENTS_ENABLED = previous;
    }
  });

  it('leaves a failed simulated payment pending and voids it on cancellation', async () => {
    const previous = process.env.DEMO_PAYMENTS_ENABLED;
    process.env.DEMO_PAYMENTS_ENABLED = 'true';
    try {
      const customer = await seedUser();
      const admin = await seedUser('admin');
      const { variantId } = await seedCart(customer.id, 1);
      const order = await orders.checkout(customer, randomUUID(), '0', { paymentType: 'demo', expectedTotalMinor: 1250 });
      const eventId = await processEventId(order.id);
      await db.query("UPDATE order_fulfillment_tasks SET snapshot = '{}'::jsonb WHERE order_id = $1", [order.id]);
      await expect(fulfillment.process(eventId, order.id)).rejects.toThrow();
      expect(await fulfillment.recordFailure(order.id, 'INVALID_SNAPSHOT', 1)).toMatchObject({ status: 'queued' });
      expect((await orders.cancel(admin, order.id)).fulfillmentStatus).toBe('cancelled');
      expect(await fulfillment.process(eventId, order.id)).toBe('cancelled');
      const payment = await db.query('SELECT status, settled_at, cancelled_at FROM simulated_payments WHERE order_id = $1', [order.id]) as
        { status: string; settled_at: Date | null; cancelled_at: Date | null }[];
      expect(payment).toMatchObject([{ status: 'cancelled', settled_at: null, cancelled_at: expect.any(Date) }]);
      const paidEvents = await db.query(
        "SELECT count(*)::int AS count FROM outbox WHERE aggregate_id = $1 AND event_type = 'order.paid'",
        [order.id],
      ) as { count: number }[];
      expect(paidEvents[0].count).toBe(0);
      const stock = await db.query('SELECT stock FROM variants WHERE id = $1', [variantId]) as { stock: number }[];
      expect(stock[0].stock).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.DEMO_PAYMENTS_ENABLED;
      else process.env.DEMO_PAYMENTS_ENABLED = previous;
    }
  });

  it('does not mutate a queued demo order when a production worker receives it', async () => {
    const previousDemo = process.env.DEMO_PAYMENTS_ENABLED;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.DEMO_PAYMENTS_ENABLED = 'true';
    try {
      const customer = await seedUser();
      await seedCart(customer.id);
      const order = await orders.checkout(customer, randomUUID(), '0', { paymentType: 'demo', expectedTotalMinor: 1250 });
      const eventId = await processEventId(order.id);
      process.env.NODE_ENV = 'production';
      await expect(fulfillment.process(eventId, order.id)).rejects.toBeInstanceOf(DemoPaymentProductionError);
      expect(await orders.get(customer, order.id)).toMatchObject({ status: 'pending', paymentStatus: 'pending', fulfillmentStatus: 'queued' });
      const rows = await db.query(
        `SELECT p.status AS payment_status, p.settled_at, t.status AS task_status, t.attempts
           FROM simulated_payments p JOIN order_fulfillment_tasks t ON t.order_id = p.order_id
          WHERE p.order_id = $1`,
        [order.id],
      ) as { payment_status: string; settled_at: Date | null; task_status: string; attempts: number }[];
      expect(rows).toEqual([{ payment_status: 'pending', settled_at: null, task_status: 'queued', attempts: 0 }]);
      const paidEvents = await db.query(
        "SELECT count(*)::int AS count FROM outbox WHERE aggregate_id = $1 AND event_type = 'order.paid'",
        [order.id],
      ) as { count: number }[];
      expect(paidEvents[0].count).toBe(0);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDemo === undefined) delete process.env.DEMO_PAYMENTS_ENABLED;
      else process.env.DEMO_PAYMENTS_ENABLED = previousDemo;
    }
  });

  it('requires readiness before payment and processes a replay once', async () => {
    const customer = await seedUser();
    const admin = await seedUser('admin');
    await seedCart(customer.id);
    const key = randomUUID();
    const order = await orders.checkout(customer, key, '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
    const eventId = await processEventId(order.id);
    await expect(orders.markPaid(admin, order.id)).rejects.toMatchObject({ status: 409 });
    expect(await fulfillment.process(eventId, order.id)).toBe('ready');
    expect(await fulfillment.process(eventId, order.id)).toBe('already_ready');
    expect(await fulfillmentState(order.id)).toMatchObject({ public_status: 'ready', task_status: 'ready', processed_at: expect.any(Date) });
    expect((await orders.get(customer, order.id)).fulfillmentStatus).toBe('ready');
    expect((await orders.status(customer, order.id)).fulfillmentStatus).toBe('ready');
    expect((await orders.markPaid(admin, order.id)).paymentStatus).toBe('paid');
    expect(await orders.checkout(customer, key, '0', { paymentType: 'cod', expectedTotalMinor: 1250 })).toEqual(order);
  });

  it('voids a queued task when an admin cancels before processing', async () => {
    const customer = await seedUser();
    const admin = await seedUser('admin');
    const { variantId } = await seedCart(customer.id);
    const order = await orders.checkout(customer, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
    const eventId = await processEventId(order.id);
    expect((await orders.cancel(admin, order.id)).fulfillmentStatus).toBe('cancelled');
    expect(await fulfillment.process(eventId, order.id)).toBe('cancelled');
    expect(await fulfillmentState(order.id)).toMatchObject({ public_status: 'cancelled', task_status: 'cancelled', voided_at: expect.any(Date) });
    const stock = await db.query('SELECT stock FROM variants WHERE id = $1', [variantId]) as { stock: number }[];
    expect(stock[0].stock).toBe(3);
  });

  it('voids a ready task and restores stock once after cancellation', async () => {
    const customer = await seedUser();
    const admin = await seedUser('admin');
    const { variantId } = await seedCart(customer.id);
    const order = await orders.checkout(customer, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
    const eventId = await processEventId(order.id);
    expect(await fulfillment.process(eventId, order.id)).toBe('ready');
    expect((await orders.cancel(admin, order.id)).fulfillmentStatus).toBe('cancelled');
    expect((await orders.cancel(admin, order.id)).fulfillmentStatus).toBe('cancelled');
    expect(await fulfillment.process(eventId, order.id)).toBe('cancelled');
    expect(await fulfillmentState(order.id)).toMatchObject({ public_status: 'cancelled', task_status: 'cancelled', voided_at: expect.any(Date) });
    const stock = await db.query('SELECT stock FROM variants WHERE id = $1', [variantId]) as { stock: number }[];
    expect(stock[0].stock).toBe(3);
  });

  it('serializes concurrent processing and cancellation without double restocking', async () => {
    const customer = await seedUser();
    const admin = await seedUser('admin');
    const { variantId } = await seedCart(customer.id);
    const order = await orders.checkout(customer, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
    const eventId = await processEventId(order.id);
    const results = await Promise.allSettled([fulfillment.process(eventId, order.id), orders.cancel(admin, order.id)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await fulfillmentState(order.id)).toMatchObject({ public_status: 'cancelled', task_status: 'cancelled', voided_at: expect.any(Date) });
    const stock = await db.query('SELECT stock FROM variants WHERE id = $1', [variantId]) as { stock: number }[];
    expect(stock[0].stock).toBe(3);
  });

  it('exhausts malformed-task retries without losing stock and permits audited cancellation', async () => {
    const customer = await seedUser();
    const admin = await seedUser('admin');
    const { variantId } = await seedCart(customer.id);
    const order = await orders.checkout(customer, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
    const eventId = await processEventId(order.id);
    await db.query("UPDATE order_fulfillment_tasks SET snapshot = '{}'::jsonb WHERE order_id = $1", [order.id]);
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await expect(fulfillment.process(eventId, order.id)).rejects.toThrow();
      const failure = await fulfillment.recordFailure(order.id, 'Invalid fulfillment snapshot', attempt);
      expect(failure).toMatchObject({ status: attempt === 6 ? 'failed' : 'queued', attempts: attempt, exhausted: attempt === 6 });
    }
    expect(await fulfillmentState(order.id)).toMatchObject({ public_status: 'failed', task_status: 'failed', attempts: 6, failed_at: expect.any(Date) });
    const beforeCancel = await db.query('SELECT stock FROM variants WHERE id = $1', [variantId]) as { stock: number }[];
    expect(beforeCancel[0].stock).toBe(2);
    await expect(orders.markPaid(admin, order.id)).rejects.toMatchObject({ status: 409 });
    expect((await orders.cancel(admin, order.id)).fulfillmentStatus).toBe('cancelled');
    const afterCancel = await db.query('SELECT stock FROM variants WHERE id = $1', [variantId]) as { stock: number }[];
    expect(afterCancel[0].stock).toBe(3);
  });

  it.skipIf(!process.env.TEST_RABBITMQ_URL)('consumes, dedupes, cancels, and dead-letters through real RabbitMQ', async () => {
    const testBrokerUrl = process.env.TEST_RABBITMQ_URL!;
    const parsedBrokerUrl = new URL(testBrokerUrl);
    const host = parsedBrokerUrl.hostname;
    if (!['localhost', '127.0.0.1', 'rabbitmq'].includes(host)) {
      throw new Error('TEST_RABBITMQ_URL must target a local test broker');
    }
    if (!decodeURIComponent(parsedBrokerUrl.pathname.slice(1)).toLowerCase().includes('test')) {
      throw new Error('TEST_RABBITMQ_URL must select an isolated test vhost');
    }
    const previousBrokerUrl = process.env.RABBITMQ_URL;
    const previousDemoPayments = process.env.DEMO_PAYMENTS_ENABLED;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.RABBITMQ_URL = testBrokerUrl;
    const broker = new BrokerService();
    const processSpy = vi.spyOn(fulfillment, 'process');
    const consumer = new OrderProcessingConsumerService(broker, fulfillment);
    let observerQueue: string | undefined;
    let retryObserverQueue: string | undefined;
    try {
      const channel = await broker.channel();
      // The URL guard above makes these test-vhost queues safe to reset between isolated schemas.
      await channel.purgeQueue(ORDER_MAIN_QUEUE);
      await channel.purgeQueue(ORDER_RETRY_QUEUE);
      await channel.purgeQueue(ORDER_DEAD_QUEUE);
      const observer = await channel.assertQueue('', { exclusive: true, autoDelete: true });
      observerQueue = observer.queue;
      await channel.bindQueue(observerQueue, DEAD_EXCHANGE, ORDER_DEAD_ROUTING_KEY);
      const retryObserver = await channel.assertQueue('', { exclusive: true, autoDelete: true });
      retryObserverQueue = retryObserver.queue;
      await channel.bindQueue(retryObserverQueue, RETRY_EXCHANGE, ORDER_RETRY_ROUTING_KEY);
      consumer.onModuleInit();
      const publish = async (eventId: string, orderId: string, attempts = 0) => {
        channel.publish(
          EVENTS_EXCHANGE,
          ORDER_ROUTING_KEY,
          Buffer.from(JSON.stringify({ eventId, eventType: 'order.process', aggregateId: orderId, payload: { orderId }, createdAt: new Date().toISOString() })),
          { persistent: true, contentType: 'application/json', messageId: eventId, type: 'order.process', headers: { attempts } },
        );
        await channel.waitForConfirms();
      };

      const readyCustomer = await seedUser();
      await seedCart(readyCustomer.id);
      const readyOrder = await orders.checkout(readyCustomer, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
      const readyEventId = await processEventId(readyOrder.id);
      await publish(readyEventId, readyOrder.id);
      await waitFor(async () => (await fulfillmentState(readyOrder.id)).task_status === 'ready' ? true : null);
      await publish(readyEventId, readyOrder.id);
      await waitFor(async () => processSpy.mock.calls.filter(([eventId]) => eventId === readyEventId).length === 2 ? true : null);
      const dedupe = await db.query(
        'SELECT count(*)::int AS count FROM consumer_dedupe WHERE event_id = $1 AND consumer = $2',
        [readyEventId, 'fulfillment'],
      ) as { count: number }[];
      expect(dedupe[0].count).toBe(1);
      expect(await fulfillmentState(readyOrder.id)).toMatchObject({ public_status: 'ready', task_status: 'ready', attempts: 0 });

      process.env.DEMO_PAYMENTS_ENABLED = 'true';
      const demoCustomer = await seedUser();
      await seedCart(demoCustomer.id);
      const demoOrder = await orders.checkout(demoCustomer, randomUUID(), '0', { paymentType: 'demo', expectedTotalMinor: 1250 });
      const demoEventId = await processEventId(demoOrder.id);
      await publish(demoEventId, demoOrder.id);
      await waitFor(async () => (await orders.get(demoCustomer, demoOrder.id)).paymentStatus === 'paid' ? true : null);
      await publish(demoEventId, demoOrder.id);
      await waitFor(async () => processSpy.mock.calls.filter(([eventId]) => eventId === demoEventId).length >= 2 ? true : null);
      expect(await orders.get(demoCustomer, demoOrder.id)).toMatchObject({ paymentStatus: 'paid', fulfillmentStatus: 'ready' });
      const demoRows = await db.query('SELECT status FROM simulated_payments WHERE order_id = $1', [demoOrder.id]) as { status: string }[];
      expect(demoRows).toEqual([{ status: 'succeeded' }]);
      const demoPaidEvents = await db.query(
        "SELECT count(*)::int AS count FROM outbox WHERE aggregate_id = $1 AND event_type = 'order.paid'",
        [demoOrder.id],
      ) as { count: number }[];
      expect(demoPaidEvents[0].count).toBe(1);

      const blockedCustomer = await seedUser();
      await seedCart(blockedCustomer.id);
      const blockedOrder = await orders.checkout(blockedCustomer, randomUUID(), '0', { paymentType: 'demo', expectedTotalMinor: 1250 });
      const blockedEventId = await processEventId(blockedOrder.id);
      process.env.NODE_ENV = 'production';
      await publish(blockedEventId, blockedOrder.id);
      const blockedDeadLetter = await waitFor(async () => {
        const message = await channel.get(observerQueue!);
        if (!message) return null;
        channel.ack(message);
        const parsed = JSON.parse(message.content.toString('utf8')) as { eventId: string };
        return parsed.eventId === blockedEventId ? message : null;
      });
      expect(blockedDeadLetter.properties.headers?.reason).toBe('DEMO_PAYMENT_PRODUCTION');
      expect(await orders.get(blockedCustomer, blockedOrder.id)).toMatchObject({ status: 'pending', fulfillmentStatus: 'queued' });
      const blockedPayment = await db.query('SELECT status FROM simulated_payments WHERE order_id = $1', [blockedOrder.id]) as { status: string }[];
      expect(blockedPayment).toEqual([{ status: 'pending' }]);
      process.env.NODE_ENV = previousNodeEnv ?? 'test';
      if (previousDemoPayments === undefined) delete process.env.DEMO_PAYMENTS_ENABLED;
      else process.env.DEMO_PAYMENTS_ENABLED = previousDemoPayments;

      const cancelledCustomer = await seedUser();
      const admin = await seedUser('admin');
      await seedCart(cancelledCustomer.id);
      const cancelledOrder = await orders.checkout(cancelledCustomer, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
      const cancelledEventId = await processEventId(cancelledOrder.id);
      await orders.cancel(admin, cancelledOrder.id);
      await publish(cancelledEventId, cancelledOrder.id);
      await waitFor(async () => {
        const rows = await db.query(
          'SELECT count(*)::int AS count FROM consumer_dedupe WHERE event_id = $1 AND consumer = $2',
          [cancelledEventId, 'fulfillment'],
        ) as { count: number }[];
        return rows[0].count === 1 ? true : null;
      });
      expect(await fulfillmentState(cancelledOrder.id)).toMatchObject({ public_status: 'cancelled', task_status: 'cancelled' });

      const retryCustomer = await seedUser();
      await seedCart(retryCustomer.id);
      const retryOrder = await orders.checkout(retryCustomer, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
      const retryEventId = await processEventId(retryOrder.id);
      await db.query("UPDATE order_fulfillment_tasks SET snapshot = '{}'::jsonb WHERE order_id = $1", [retryOrder.id]);
      await publish(retryEventId, retryOrder.id);
      const retryMessage = await waitFor(async () => {
        const message = await channel.get(retryObserverQueue!);
        if (!message) return null;
        channel.ack(message);
        const parsed = JSON.parse(message.content.toString('utf8')) as { eventId: string };
        return parsed.eventId === retryEventId ? message : null;
      });
      expect(retryMessage.properties.headers?.attempts).toBe(1);
      expect((await fulfillmentState(retryOrder.id)).attempts).toBeGreaterThanOrEqual(1);
      expect((await orders.cancel(admin, retryOrder.id)).fulfillmentStatus).toBe('cancelled');
      await waitFor(async () => {
        const rows = await db.query(
          'SELECT count(*)::int AS count FROM consumer_dedupe WHERE event_id = $1 AND consumer = $2',
          [retryEventId, 'fulfillment'],
        ) as { count: number }[];
        return rows[0].count === 1 ? true : null;
      });
      expect(await fulfillmentState(retryOrder.id)).toMatchObject({ public_status: 'cancelled', task_status: 'cancelled' });

      const failedCustomer = await seedUser();
      const { variantId } = await seedCart(failedCustomer.id);
      const failedOrder = await orders.checkout(failedCustomer, randomUUID(), '0', { paymentType: 'cod', expectedTotalMinor: 1250 });
      const failedEventId = await processEventId(failedOrder.id);
      await db.query("UPDATE order_fulfillment_tasks SET snapshot = '{}'::jsonb WHERE order_id = $1", [failedOrder.id]);
      await publish(failedEventId, failedOrder.id, 5);
      await waitFor(async () => (await fulfillmentState(failedOrder.id)).task_status === 'failed' ? true : null);
      const deadLetter = await waitFor(async () => {
        const message = await channel.get(observerQueue!);
        if (!message) return null;
        channel.ack(message);
        const parsed = JSON.parse(message.content.toString('utf8')) as { eventId: string };
        return parsed.eventId === failedEventId ? parsed : null;
      });
      expect(deadLetter.eventId).toBe(failedEventId);
      expect(await fulfillmentState(failedOrder.id)).toMatchObject({ public_status: 'failed', task_status: 'failed', attempts: 6 });
      const stock = await db.query('SELECT stock FROM variants WHERE id = $1', [variantId]) as { stock: number }[];
      expect(stock[0].stock).toBe(2);

      const missingOrderId = randomUUID();
      const missingEventId = randomUUID();
      await publish(missingEventId, missingOrderId);
      const missingDeadLetter = await waitFor(async () => {
        const message = await channel.get(observerQueue!);
        if (!message) return null;
        channel.ack(message);
        const parsed = JSON.parse(message.content.toString('utf8')) as { eventId: string };
        return parsed.eventId === missingEventId ? parsed : null;
      });
      expect(missingDeadLetter.eventId).toBe(missingEventId);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(processSpy.mock.calls.filter(([eventId]) => eventId === missingEventId)).toHaveLength(1);
      expect((await channel.checkQueue(ORDER_MAIN_QUEUE)).messageCount).toBe(0);
      expect((await channel.checkQueue(ORDER_RETRY_QUEUE)).messageCount).toBe(0);
    } finally {
      await consumer.onModuleDestroy();
      if (observerQueue) {
        const channel = await broker.channel().catch(() => null);
        if (channel) await channel.deleteQueue(observerQueue).catch(() => undefined);
      }
      if (retryObserverQueue) {
        const channel = await broker.channel().catch(() => null);
        if (channel) await channel.deleteQueue(retryObserverQueue).catch(() => undefined);
      }
      await broker.onModuleDestroy();
      processSpy.mockRestore();
      if (previousBrokerUrl === undefined) delete process.env.RABBITMQ_URL;
      else process.env.RABBITMQ_URL = previousBrokerUrl;
      if (previousDemoPayments === undefined) delete process.env.DEMO_PAYMENTS_ENABLED;
      else process.env.DEMO_PAYMENTS_ENABLED = previousDemoPayments;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  }, 20_000);
});
