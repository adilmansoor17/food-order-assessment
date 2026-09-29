import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.js';

const production = {
  NODE_ENV: 'production',
  DB_HOST: 'postgres',
  DB_USER: 'food_ordering',
  DB_PASSWORD: 'unique-database-password',
  DB_NAME: 'food_ordering',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  OTP_PEPPER: 'c'.repeat(40),
  OTP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  AUTH_TOKEN_HASH_SECRET: 'd'.repeat(40),
  REDIS_URL: 'redis://:unique-cache-password@redis:6379',
  RABBITMQ_URL: 'amqp://food_ordering:unique-broker-password@rabbitmq:5672',
  WEB_ORIGIN: 'https://shop.example',
  BANK_NAME: 'Example Bank',
  BANK_ACCOUNT_NAME: 'Shop',
  BANK_IBAN: 'PK00TEST0000000000000000',
  SMTP_HOST: 'smtp.example',
  SMTP_FROM: 'orders@example',
  TWILIO_ACCOUNT_SID: 'sid',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_FROM_NUMBER: '+10000000000',
};

describe('production environment', () => {
  it('accepts configured Redis and RabbitMQ credentials', () => {
    expect(validateEnv(production)).toBe(production);
  });

  it.each([
    ['REDIS_URL', 'redis://:replace_with_random_redis_password@redis:6379'],
    ['RABBITMQ_URL', 'amqp://food_ordering:food_ordering_dev@rabbitmq:5672'],
    ['RABBITMQ_URL', 'amqp://food_ordering@rabbitmq:5672'],
  ])('rejects an unsafe %s', (key, value) => {
    expect(() => validateEnv({ ...production, [key]: value })).toThrow(key);
  });

  it('rejects simulated payments in production', () => {
    expect(() => validateEnv({ ...production, DEMO_PAYMENTS_ENABLED: 'true' })).toThrow('Demo payments');
    expect(validateEnv({ ...production, DEMO_PAYMENTS_ENABLED: 'false' })).toBeTruthy();
  });
});
