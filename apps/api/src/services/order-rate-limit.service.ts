import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { capacityLimit } from '../config/capacity.js';
import { consumeRateLimit } from '../utils/rate-limit.js';

@Injectable()
export class OrderRateLimitService {
  private readonly secret: string;
  private readonly readsPerMinute: number;
  private readonly checkoutAttemptsPerHour: number;
  private readonly customerChangesPerHour: number;
  private readonly adminChangesPerMinute: number;

  constructor(private readonly db: DataSource, config: ConfigService) {
    this.secret = config.get<string>('AUTH_TOKEN_HASH_SECRET') ?? '';
    if (this.secret.length < 32) throw new Error('AUTH_TOKEN_HASH_SECRET must be configured');
    this.readsPerMinute = capacityLimit('ORDER_READS_PER_MINUTE', 120, 1000, config.get<string>('ORDER_READS_PER_MINUTE'));
    this.checkoutAttemptsPerHour = capacityLimit('CHECKOUT_ATTEMPTS_PER_HOUR', 12, 100, config.get<string>('CHECKOUT_ATTEMPTS_PER_HOUR'));
    this.customerChangesPerHour = capacityLimit('ORDER_CHANGES_PER_HOUR', 12, 100, config.get<string>('ORDER_CHANGES_PER_HOUR'));
    this.adminChangesPerMinute = capacityLimit('ADMIN_ORDER_CHANGES_PER_MINUTE', 60, 300, config.get<string>('ADMIN_ORDER_CHANGES_PER_MINUTE'));
  }

  read(userId: string): Promise<void> {
    return consumeRateLimit(this.db, this.secret, 'orders:read', userId, this.readsPerMinute, 60);
  }

  checkout(userId: string): Promise<void> {
    return consumeRateLimit(this.db, this.secret, 'orders:checkout', userId, this.checkoutAttemptsPerHour, 3600);
  }

  customerChange(userId: string): Promise<void> {
    return consumeRateLimit(this.db, this.secret, 'orders:customer-change', userId, this.customerChangesPerHour, 3600);
  }

  adminChange(userId: string): Promise<void> {
    return consumeRateLimit(this.db, this.secret, 'orders:admin-change', userId, this.adminChangesPerMinute, 60);
  }
}
