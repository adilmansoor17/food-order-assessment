import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CatalogCacheService } from './catalog-cache.service.js';
import {
  AddVariantDto,
  AdjustStockDto,
  CreateProductDto,
  CreateVariantDto,
  UpdateProductDto,
  UpdateVariantDto,
} from '../models/products.dto.js';

interface ProductRow {
  id: string;
  name: string;
  description: string;
  active: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface VariantRow {
  id: string;
  product_id: string;
  name: string;
  sku: string;
  price_minor: string;
  stock: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireUuid(value: string): string {
  if (!UUID.test(value)) {
    throw new BadRequestException({ code: 'INVALID_ID', message: 'Invalid ID' });
  }
  return value;
}

function requiredText(value: string, name: string, max: number): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > max) {
    throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `Invalid ${name}` });
  }
  return trimmed;
}

function uniqueConflict(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    throw new ConflictException({ code: 'SKU_IN_USE', message: 'A SKU is already in use' });
  }
  throw error;
}

function variantView(row: VariantRow) {
  return {
    id: row.id,
    productId: row.product_id,
    name: row.name,
    sku: row.sku,
    priceMinor: Number(row.price_minor),
    currency: 'PKR' as const,
    stock: row.stock,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function productView(row: ProductRow, variants: VariantRow[]) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    active: row.active,
    archivedAt: row.archived_at,
    variants: variants.map(variantView),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicProductView(row: ProductRow, variants: VariantRow[]) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    variants: variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      priceMinor: Number(variant.price_minor),
      currency: 'PKR' as const,
      available: variant.stock > 0,
    })),
  };
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly db: DataSource,
    private readonly cache: CatalogCacheService,
  ) {}

  async list(cursor?: string, limitValue?: string) {
    const limit = limitValue === undefined ? 20 : Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new BadRequestException({ code: 'INVALID_LIMIT', message: 'Limit must be 1 to 50' });
    }
    if (cursor !== undefined) requireUuid(cursor);
    const generation = await this.cache.generation();
    const key = `catalog-public-v2:${generation}:list:${cursor ?? 'first'}:${limit}`;
    const cached = await this.cache.get(key);
    if (cached) return JSON.parse(cached) as { items: unknown[]; nextCursor: string | null };

    let cursorCreatedAt: Date | null = null;
    if (cursor) {
      const found = (await this.db.query('SELECT created_at FROM products WHERE id = $1', [cursor])) as {
        created_at: Date;
      }[];
      if (!found[0]) {
        throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'Invalid cursor' });
      }
      cursorCreatedAt = found[0].created_at;
    }
    const rows = (await this.db.query(
      `SELECT id, name, description, active, archived_at, created_at, updated_at
       FROM products
       WHERE active = true AND archived_at IS NULL
         AND ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [cursorCreatedAt, cursor ?? null, limit + 1],
    )) as ProductRow[];
    const page = rows.slice(0, limit);
    const variants = await this.variantsFor(page.map((item) => item.id), false);
    const byProduct = this.groupVariants(variants);
    const result = {
      items: page.map((item) => publicProductView(item, byProduct.get(item.id) ?? [])),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null,
    };
    await this.cache.set(key, JSON.stringify(result));
    return result;
  }

  async get(id: string, admin = false) {
    requireUuid(id);
    if (!admin) {
      const generation = await this.cache.generation();
      const key = `catalog-public-v2:${generation}:product:${id}`;
      const cached = await this.cache.get(key);
      if (cached) return JSON.parse(cached) as ReturnType<typeof publicProductView>;
      const result = await this.readProduct(id, false);
      await this.cache.set(key, JSON.stringify(result));
      return result;
    }
    return this.readProduct(id, true);
  }

  async listAdmin(cursor?: string, limitValue?: string) {
    const limit = limitValue === undefined ? 20 : Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new BadRequestException({ code: 'INVALID_LIMIT', message: 'Limit must be 1 to 50' });
    }
    if (cursor !== undefined) requireUuid(cursor);
    const rows = (await this.db.query(
      `SELECT id, name, description, active, archived_at, created_at, updated_at
       FROM products WHERE ($1::uuid IS NULL OR id < $1::uuid)
       ORDER BY id DESC LIMIT $2`,
      [cursor ?? null, limit + 1],
    )) as ProductRow[];
    const page = rows.slice(0, limit);
    const byProduct = this.groupVariants(await this.variantsFor(page.map((item) => item.id), true));
    return {
      items: page.map((item) => productView(item, byProduct.get(item.id) ?? [])),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null,
    };
  }

  async create(dto: CreateProductDto, actorId: string) {
    const id = randomUUID();
    const name = requiredText(dto.name, 'name', 160);
    const description = dto.description?.trim() ?? '';
    if (!dto.variants?.length) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'At least one variant is required' });
    }
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO products (id, name, description, active) VALUES ($1, $2, $3, $4)`,
          [id, name, description, dto.active ?? true],
        );
        for (const variant of dto.variants) {
          await this.insertVariant(tx, id, variant);
        }
        await this.audit(tx, actorId, 'product.create', id, { variantCount: dto.variants.length });
      });
    } catch (error) {
      uniqueConflict(error);
    }
    await this.cache.invalidate();
    return this.get(id, true);
  }

  async update(id: string, dto: UpdateProductDto, actorId: string) {
    requireUuid(id);
    if (dto.name === undefined && dto.description === undefined && dto.active === undefined) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'No changes supplied' });
    }
    const name = dto.name === undefined ? null : requiredText(dto.name, 'name', 160);
    const description = dto.description === undefined ? null : dto.description.trim();
    await this.db.transaction(async (tx) => {
      const rows = (await tx.query('SELECT archived_at FROM products WHERE id = $1 FOR UPDATE', [id])) as {
        archived_at: Date | null;
      }[];
      if (!rows[0]) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
      if (rows[0].archived_at) {
        throw new ConflictException({ code: 'PRODUCT_ARCHIVED', message: 'Archived products cannot be changed' });
      }
      await tx.query(
        `UPDATE products SET name = COALESCE($2, name), description = COALESCE($3, description),
         active = COALESCE($4, active), updated_at = NOW() WHERE id = $1`,
        [id, name, description, dto.active ?? null],
      );
      await this.audit(tx, actorId, 'product.update', id, dto);
    });
    await this.cache.invalidate();
    return this.get(id, true);
  }

  async archive(id: string, actorId: string) {
    requireUuid(id);
    await this.db.transaction(async (tx) => {
      const rows = (await tx.query(
        `UPDATE products SET active = false, archived_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND archived_at IS NULL RETURNING id`,
        [id],
      )) as [{ id: string }[], number];
      if (rows[1] === 0) {
        const exists = (await tx.query('SELECT id FROM products WHERE id = $1', [id])) as { id: string }[];
        if (!exists[0]) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
        return;
      }
      await tx.query(
        `UPDATE variants SET active = false, updated_at = NOW()
         WHERE product_id = $1 AND active = true`,
        [id],
      );
      await this.audit(tx, actorId, 'product.archive', id, {});
    });
    await this.cache.invalidate();
    return this.get(id, true);
  }

  async addVariant(productId: string, dto: AddVariantDto, actorId: string) {
    requireUuid(productId);
    let variantId: string;
    try {
      variantId = await this.db.transaction(async (tx) => {
        const product = (await tx.query('SELECT archived_at FROM products WHERE id = $1 FOR UPDATE', [productId])) as {
          archived_at: Date | null;
        }[];
        if (!product[0]) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
        if (product[0].archived_at) {
          throw new ConflictException({ code: 'PRODUCT_ARCHIVED', message: 'Product is archived' });
        }
        const id = await this.insertVariant(tx, productId, dto);
        await this.audit(tx, actorId, 'variant.create', id, { productId });
        return id;
      });
    } catch (error) {
      uniqueConflict(error);
    }
    await this.cache.invalidate();
    return this.getVariant(variantId);
  }

  async updateVariant(id: string, dto: UpdateVariantDto, actorId: string) {
    requireUuid(id);
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'No changes supplied' });
    }
    const name = dto.name === undefined ? null : requiredText(dto.name, 'name', 120);
    const sku = dto.sku === undefined ? null : requiredText(dto.sku, 'SKU', 80);
    try {
      await this.db.transaction(async (tx) => {
        const variant = (await tx.query(
          `SELECT v.product_id, p.archived_at FROM variants v
           JOIN products p ON p.id = v.product_id WHERE v.id = $1 FOR UPDATE OF v, p`,
          [id],
        )) as { product_id: string; archived_at: Date | null }[];
        if (!variant[0]) throw new NotFoundException({ code: 'VARIANT_NOT_FOUND', message: 'Variant not found' });
        if (variant[0].archived_at) {
          throw new ConflictException({ code: 'PRODUCT_ARCHIVED', message: 'Product is archived' });
        }
        await tx.query(
          `UPDATE variants SET name = COALESCE($2, name), sku = COALESCE($3, sku),
           price_minor = COALESCE($4, price_minor), active = COALESCE($5, active),
           updated_at = NOW() WHERE id = $1`,
          [id, name, sku, dto.priceMinor ?? null, dto.active ?? null],
        );
        await this.audit(tx, actorId, 'variant.update', id, dto);
      });
    } catch (error) {
      uniqueConflict(error);
    }
    await this.cache.invalidate();
    return this.getVariant(id);
  }

  async archiveVariant(id: string, actorId: string) {
    requireUuid(id);
    await this.db.transaction(async (tx) => {
      const rows = (await tx.query(
        `UPDATE variants SET active = false, updated_at = NOW()
         WHERE id = $1 AND active = true RETURNING id`,
        [id],
      )) as [{ id: string }[], number];
      if (rows[1] === 0) {
        const exists = (await tx.query('SELECT id FROM variants WHERE id = $1', [id])) as { id: string }[];
        if (!exists[0]) throw new NotFoundException({ code: 'VARIANT_NOT_FOUND', message: 'Variant not found' });
        return;
      }
      await this.audit(tx, actorId, 'variant.archive', id, {});
    });
    await this.cache.invalidate();
    return this.getVariant(id);
  }

  async adjustStock(id: string, dto: AdjustStockDto, actorId: string) {
    requireUuid(id);
    if (!dto.delta || !Number.isInteger(dto.delta)) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Stock delta must be a nonzero integer' });
    }
    const reason = requiredText(dto.reason, 'reason', 500);
    await this.db.transaction(async (tx) => {
      const beforeRows = (await tx.query('SELECT stock FROM variants WHERE id = $1 FOR UPDATE', [id])) as {
        stock: number;
      }[];
      if (!beforeRows[0]) throw new NotFoundException({ code: 'VARIANT_NOT_FOUND', message: 'Variant not found' });
      const after = beforeRows[0].stock + dto.delta;
      if (after < 0 || after > 2_147_483_647) {
        throw new ConflictException({ code: 'INVALID_STOCK', message: 'Stock adjustment exceeds available range' });
      }
      await tx.query('UPDATE variants SET stock = $2, updated_at = NOW() WHERE id = $1', [id, after]);
      await this.audit(tx, actorId, 'variant.stock_adjust', id, {
        delta: dto.delta,
        reason,
        before: beforeRows[0].stock,
        after,
      });
    });
    await this.cache.invalidate();
    return this.getVariant(id);
  }

  private async readProduct(id: string, admin: boolean) {
    const rows = (await this.db.query(
      `SELECT id, name, description, active, archived_at, created_at, updated_at
       FROM products WHERE id = $1 ${admin ? '' : 'AND active = true AND archived_at IS NULL'}`,
      [id],
    )) as ProductRow[];
    if (!rows[0]) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
    const variants = await this.variantsFor([id], admin);
    return admin ? productView(rows[0], variants) : publicProductView(rows[0], variants);
  }

  private async getVariant(id: string) {
    const rows = (await this.db.query(
      `SELECT id, product_id, name, sku, price_minor, stock, active, created_at, updated_at
       FROM variants WHERE id = $1`,
      [id],
    )) as VariantRow[];
    if (!rows[0]) throw new NotFoundException({ code: 'VARIANT_NOT_FOUND', message: 'Variant not found' });
    return variantView(rows[0]);
  }

  private async variantsFor(productIds: string[], admin: boolean): Promise<VariantRow[]> {
    if (!productIds.length) return [];
    return (await this.db.query(
      `SELECT id, product_id, name, sku, price_minor, stock, active, created_at, updated_at
       FROM variants WHERE product_id = ANY($1::uuid[]) ${admin ? '' : 'AND active = true'}
       ORDER BY created_at ASC, id ASC`,
      [productIds],
    )) as VariantRow[];
  }

  private groupVariants(rows: VariantRow[]): Map<string, VariantRow[]> {
    const grouped = new Map<string, VariantRow[]>();
    for (const row of rows) {
      const group = grouped.get(row.product_id) ?? [];
      group.push(row);
      grouped.set(row.product_id, group);
    }
    return grouped;
  }

  private async insertVariant(tx: EntityManager, productId: string, dto: CreateVariantDto) {
    const id = randomUUID();
    const name = requiredText(dto.name, 'variant name', 120);
    const sku = requiredText(dto.sku, 'SKU', 80);
    if (!Number.isSafeInteger(dto.priceMinor) || dto.priceMinor < 1 || dto.priceMinor > 100_000_000_000) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Invalid price' });
    }
    if (!Number.isInteger(dto.initialStock) || dto.initialStock < 0 || dto.initialStock > 1_000_000_000) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Invalid initial stock' });
    }
    await tx.query(
      `INSERT INTO variants (id, product_id, name, sku, price_minor, stock)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, productId, name, sku, dto.priceMinor, dto.initialStock],
    );
    return id;
  }

  private async audit(tx: EntityManager, actorId: string, action: string, targetId: string, metadata: unknown) {
    await tx.query(
      `INSERT INTO admin_audit (id, actor_id, action, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [randomUUID(), actorId, action, targetId, JSON.stringify(metadata)],
    );
  }
}
