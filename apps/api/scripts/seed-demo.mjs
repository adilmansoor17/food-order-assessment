import pg from 'pg';
import { randomUUID } from 'node:crypto';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Demo catalog seed is disabled in production');
}

const catalog = [
  { name: 'Chicken Tikka Roll', description: 'Chicken tikka, onion, lettuce, and mint chutney in a paratha.', variants: [
    { name: 'Regular', sku: 'DEMO-TIKKA-ROLL-REG', priceMinor: 69000, stock: 50 },
    { name: 'Large', sku: 'DEMO-TIKKA-ROLL-LRG', priceMinor: 89000, stock: 50 },
  ] },
  { name: 'Chapli Kebab Bun', description: 'Chapli kebab, pickled onion, lettuce, and chutney in a bun.', variants: [
    { name: 'Single', sku: 'DEMO-CHAPLI-BUN-SGL', priceMinor: 79000, stock: 50 },
    { name: 'Double', sku: 'DEMO-CHAPLI-BUN-DBL', priceMinor: 99000, stock: 50 },
  ] },
  { name: 'Chicken Biryani Bowl', description: 'Basmati rice, chicken, fried onion, and raita.', variants: [
    { name: 'Regular', sku: 'DEMO-BIRYANI-BOWL-REG', priceMinor: 82000, stock: 50 },
    { name: 'Large', sku: 'DEMO-BIRYANI-BOWL-LRG', priceMinor: 105000, stock: 50 },
  ] },
  { name: 'Beef Seekh Roll', description: 'Beef seekh kebab, onion, cucumber, and mint chutney in a paratha.', variants: [
    { name: 'Regular', sku: 'DEMO-SEEKH-ROLL-REG', priceMinor: 62000, stock: 50 },
    { name: 'Double', sku: 'DEMO-SEEKH-ROLL-DBL', priceMinor: 85000, stock: 50 },
  ] },
  { name: 'Daal Chawal Bowl', description: 'Lentils, steamed rice, achar, and coriander.', variants: [
    { name: 'Regular', sku: 'DEMO-DAAL-BOWL-REG', priceMinor: 59000, stock: 50 },
    { name: 'Large', sku: 'DEMO-DAAL-BOWL-LRG', priceMinor: 79000, stock: 50 },
  ] },
  { name: 'Masala Fries', description: 'Potato fries with a masala seasoning.', variants: [
    { name: 'Regular', sku: 'DEMO-FRIES-REG', priceMinor: 29000, stock: 80 },
    { name: 'Large', sku: 'DEMO-FRIES-LRG', priceMinor: 39000, stock: 80 },
  ] },
  { name: 'Mint Lemonade', description: 'Lemon, mint, sugar, and soda water.', variants: [
    { name: 'Glass', sku: 'DEMO-MINT-LEMONADE-GLASS', priceMinor: 25000, stock: 100 },
    { name: 'Jug', sku: 'DEMO-MINT-LEMONADE-JUG', priceMinor: 45000, stock: 40 },
  ] },
  { name: 'Gulab Jamun', description: 'Gulab jamun served with syrup.', variants: [
    { name: 'Two pieces', sku: 'DEMO-GULAB-JAMUN-2', priceMinor: 26000, stock: 80 },
    { name: 'Four pieces', sku: 'DEMO-GULAB-JAMUN-4', priceMinor: 48000, stock: 50 },
  ] },
];

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
  await client.query('SELECT pg_advisory_xact_lock(816903123)');
  let created = 0;
  for (const product of catalog) {
    const skus = product.variants.map((variant) => variant.sku);
    const existing = await client.query('SELECT 1 FROM variants WHERE sku = ANY($1::text[]) LIMIT 1', [skus]);
    if (existing.rowCount) continue;
    const productId = randomUUID();
    await client.query('INSERT INTO products (id, name, description) VALUES ($1, $2, $3)', [productId, product.name, product.description]);
    for (const variant of product.variants) {
      await client.query(
        `INSERT INTO variants (id, product_id, name, sku, price_minor, stock)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), productId, variant.name, variant.sku, variant.priceMinor, variant.stock],
      );
    }
    created += 1;
  }
  await client.query('COMMIT');
  process.stdout.write(`Created ${created} demo products\n`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
