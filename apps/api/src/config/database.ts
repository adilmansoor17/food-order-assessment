import type { ConfigService } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { capacityLimit } from './capacity.js';

export function databaseOptions(config: ConfigService): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: config.get<string>('DB_HOST') ?? '127.0.0.1',
    port: Number(config.get<string>('DB_PORT') ?? config.get<string>('POSTGRES_PORT') ?? '5433'),
    username: config.get<string>('DB_USER') ?? config.get<string>('POSTGRES_USER') ?? 'food_ordering',
    password: config.get<string>('DB_PASSWORD') ?? config.get<string>('POSTGRES_PASSWORD') ?? 'food_ordering_dev',
    database: config.get<string>('DB_NAME') ?? config.get<string>('POSTGRES_DB') ?? 'food_ordering',
    extra: {
      max: capacityLimit('DB_POOL_MAX', 10, 100, config.get<string>('DB_POOL_MAX')),
      connectionTimeoutMillis: capacityLimit('DB_ACQUIRE_TIMEOUT_MS', 5000, 60000, config.get<string>('DB_ACQUIRE_TIMEOUT_MS')),
    },
    synchronize: false,
  };
}
