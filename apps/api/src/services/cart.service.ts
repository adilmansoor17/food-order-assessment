import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { capacityLimit } from '../config/capacity.js';
import { requireUuid } from './products.service.js';

interface CartRow {
  id: string;
  version: number;
}

interface CartLineRow {
  id: string;
  version: number;
  variant_id: string | null;
  product_id: string | null;
  product_name: string | null;
  variant_name: string | null;
  price_minor: string | null;
  stock: number | null;
  variant_active: boolean | null;
  product_active: boolean | null;
  archived_at: Date | null;
  quantity: number | null;
}

export function parseCartVersion(header: string | undefined): number {
  if (header === undefined) {
    throw new HttpException({ code: 'IF_MATCH_REQUIRED', message: 'If-Match cart version is required' }, 428);
  }
  const match = /^(?:"([0-9]+)"|([0-9]+))$/.exec(header.trim());
  const version = match ? Number(match[1] ?? match[2]) : NaN;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new BadRequestException({ code: 'INVALID_IF_MATCH', message: 'Invalid cart version' });
  }
  return version;
}

@Injectable()
export class CartService {
  private readonly maxLines = capacityLimit('CART_MAX_LINES', 100, 1000);

  constructor(private readonly db: DataSource) {}

  async get(userId: string) {
    await this.ensureCart(this.db.manager, userId);
    return this.readCart(this.db.manager, userId);
  }

  async putItem(userId: string, variantId: string, quantity: number, expectedVersion: number) {
    requireUuid(variantId);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Quantity must be 1 to 99' });
    }
    return this.db.transaction(async (tx) => {
      const cart = await this.lockCart(tx, userId);
      this.requireVersion(cart.version, expectedVersion);
      const rows = (await tx.query(
        `SELECT v.stock FROM variants v JOIN products p ON p.id = v.product_id
         WHERE v.id = $1 AND v.active = true AND p.active = true AND p.archived_at IS NULL`,
        [variantId],
      )) as { stock: number }[];
      if (!rows[0] || rows[0].stock < quantity) {
        throw new ConflictException({ code: 'VARIANT_UNAVAILABLE', message: 'Variant is unavailable' });
      }
      const lineCount = (await tx.query(
        'SELECT count(*)::int AS count FROM cart_items WHERE cart_id = $1 AND variant_id <> $2',
        [cart.id, variantId],
      )) as { count: number }[];
      if (lineCount[0].count >= this.maxLines) {
        throw new ConflictException({ code: 'CART_LINE_LIMIT', message: 'Cart has too many distinct items' });
      }
      await tx.query(
        `INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1, $2, $3)
         ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
        [cart.id, variantId, quantity],
      );
      await tx.query('UPDATE carts SET version = version + 1, updated_at = NOW() WHERE id = $1', [cart.id]);
      return this.readCart(tx, userId);
    });
  }

  async removeItem(userId: string, variantId: string, expectedVersion: number) {
    requireUuid(variantId);
    return this.db.transaction(async (tx) => {
      const cart = await this.lockCart(tx, userId);
      this.requireVersion(cart.version, expectedVersion);
      const deleted = (await tx.query(
        'DELETE FROM cart_items WHERE cart_id = $1 AND variant_id = $2 RETURNING variant_id',
        [cart.id, variantId],
      )) as [{ variant_id: string }[], number];
      if (deleted[1] > 0) {
        await tx.query('UPDATE carts SET version = version + 1, updated_at = NOW() WHERE id = $1', [cart.id]);
      }
      return this.readCart(tx, userId);
    });
  }

  private requireVersion(actual: number, expected: number) {
    if (actual !== expected) {
      throw new HttpException({ code: 'CART_VERSION_CONFLICT', message: 'Cart changed; refresh and retry' }, 412);
    }
  }

  private async ensureCart(tx: EntityManager, userId: string) {
    await tx.query('INSERT INTO carts (id, user_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [
      randomUUID(),
      userId,
    ]);
  }

  private async lockCart(tx: EntityManager, userId: string): Promise<CartRow> {
    await this.ensureCart(tx, userId);
    const rows = (await tx.query('SELECT id, version FROM carts WHERE user_id = $1 FOR UPDATE', [userId])) as CartRow[];
    return rows[0];
  }

  private async readCart(tx: EntityManager, userId: string) {
    const rows = (await tx.query(
      `SELECT c.id, c.version, ci.variant_id, ci.quantity, v.product_id,
              p.name AS product_name, v.name AS variant_name, v.price_minor, v.stock,
              v.active AS variant_active, p.active AS product_active, p.archived_at
       FROM carts c
       LEFT JOIN cart_items ci ON ci.cart_id = c.id
       LEFT JOIN variants v ON v.id = ci.variant_id
       LEFT JOIN products p ON p.id = v.product_id
       WHERE c.user_id = $1 ORDER BY ci.variant_id`,
      [userId],
    )) as CartLineRow[];
    const cart = rows[0];
    if (!cart) {
      throw new ConflictException({ code: 'CART_UNAVAILABLE', message: 'Cart is unavailable' });
    }
    let total = 0n;
    const items = rows
      .filter((row): row is CartLineRow & { variant_id: string; quantity: number; price_minor: string } =>
        row.variant_id !== null && row.quantity !== null && row.price_minor !== null,
      )
      .map((row) => {
        const line = BigInt(row.price_minor) * BigInt(row.quantity);
        total += line;
        if (line > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new ConflictException({ code: 'CART_TOTAL_TOO_LARGE', message: 'Cart total is too large' });
        }
        return {
          productId: row.product_id,
          variantId: row.variant_id,
          name: `${row.product_name} — ${row.variant_name}`,
          productName: row.product_name,
          variantName: row.variant_name,
          quantity: row.quantity,
          unitPriceMinor: Number(row.price_minor),
          lineTotalMinor: Number(line),
          available: Boolean(row.variant_active && row.product_active && !row.archived_at && (row.stock ?? 0) >= row.quantity),
        };
      });
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConflictException({ code: 'CART_TOTAL_TOO_LARGE', message: 'Cart total is too large' });
    }
    return {
      id: cart.id,
      userId,
      version: cart.version,
      items,
      totalMinor: Number(total),
      estimatedTotalMinor: Number(total),
      currency: 'PKR' as const,
    };
  }
}
