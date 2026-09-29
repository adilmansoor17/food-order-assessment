import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class CatalogCacheService implements OnModuleDestroy {
  private readonly client: Redis;
  private connecting?: Promise<void>;

  constructor() {
    this.client = new Redis(
      process.env.REDIS_URL ??
        `redis://${process.env.REDIS_HOST ?? '127.0.0.1'}:${process.env.REDIS_PORT ?? '6379'}`,
      {
        lazyConnect: true,
        enableOfflineQueue: false,
        connectTimeout: 500,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      },
    );
    // A cache failure must not turn a catalog read into a process error.
    this.client.on('error', () => undefined);
  }

  private async ready(): Promise<boolean> {
    if (this.client.status === 'ready') return true;
    if (!this.connecting) {
      this.connecting = this.client
        .connect()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.connecting = undefined;
        });
    }
    await this.connecting;
    return String(this.client.status) === 'ready';
  }

  async get(key: string): Promise<string | null> {
    try {
      return (await this.ready()) ? await this.client.get(key) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, seconds = 30): Promise<void> {
    try {
      if (await this.ready()) await this.client.set(key, value, 'EX', seconds);
    } catch {
      // PostgreSQL remains authoritative.
    }
  }

  async invalidate(): Promise<void> {
    try {
      if (!(await this.ready())) return;
      await this.client.incr('catalog:generation');
    } catch {
      // Short TTL bounds stale data if Redis cannot be invalidated.
    }
  }

  async generation(): Promise<string> {
    return (await this.get('catalog:generation')) ?? '0';
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status === 'ready') await this.client.quit();
    else this.client.disconnect();
  }
}
