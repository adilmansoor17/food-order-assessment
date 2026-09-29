import { HttpException, HttpStatus } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { keyedDigest } from './auth-security.js';

/** A PostgreSQL counter shared by all API replicas. Keys never expose identities. */
export async function consumeRateLimit(
  db: Pick<DataSource, 'query'>,
  secret: string,
  scope: string,
  subject: string,
  max: number,
  windowSeconds: number,
): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStartSeconds = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const key = keyedDigest(secret, `${scope}:${subject}`);
  const rows = (await db.query(
    `INSERT INTO auth_rate_counters (key, window_start, count)
     VALUES ($1, to_timestamp($2), 1)
     ON CONFLICT (key, window_start)
     DO UPDATE SET count = LEAST(auth_rate_counters.count + 1, $3)
     RETURNING count`,
    [key, windowStartSeconds, max + 1],
  )) as Array<{ count: number }>;
  if (Number(rows[0]?.count) > max) {
    const retryAfterSeconds = windowStartSeconds + windowSeconds - nowSeconds;
    throw new HttpException(
      { code: 'RATE_LIMITED', message: 'Too many attempts', retryAfterSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
