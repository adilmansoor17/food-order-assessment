const requiredInProduction = [
  'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'OTP_PEPPER',
  'OTP_ENCRYPTION_KEY', 'AUTH_TOKEN_HASH_SECRET', 'REDIS_URL', 'RABBITMQ_URL',
  'WEB_ORIGIN', 'BANK_NAME', 'BANK_ACCOUNT_NAME', 'BANK_IBAN',
  'SMTP_HOST', 'SMTP_FROM', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
] as const;

function productionConnectionSecret(raw: Record<string, unknown>, key: 'REDIS_URL' | 'RABBITMQ_URL'): string {
  try {
    const url = new URL(String(raw[key]));
    const allowed = key === 'REDIS_URL' ? ['redis:', 'rediss:'] : ['amqp:', 'amqps:'];
    if (!allowed.includes(url.protocol) || !url.hostname || (key === 'RABBITMQ_URL' && !url.username)) {
      throw new Error('Invalid connection URL');
    }
    return decodeURIComponent(url.password);
  } catch {
    throw new Error(`${key} must be a valid authenticated connection URL`);
  }
}

export function validateEnv(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.DEMO_PAYMENTS_ENABLED !== undefined &&
      (typeof raw.DEMO_PAYMENTS_ENABLED !== 'string' || !['true', 'false'].includes(raw.DEMO_PAYMENTS_ENABLED))) {
    throw new Error('DEMO_PAYMENTS_ENABLED must be true or false');
  }
  if (raw.NODE_ENV === 'production') {
    if (raw.DEMO_PAYMENTS_ENABLED === 'true') throw new Error('Demo payments are not allowed in production');
    const missing = requiredInProduction.filter((key) => typeof raw[key] !== 'string' || !String(raw[key]).trim());
    if (missing.length) throw new Error(`Missing production environment values: ${missing.join(', ')}`);
    if (raw.DB_PASSWORD === 'food_ordering_dev') throw new Error('Development database password is not allowed in production');
    const placeholders = requiredInProduction.filter((key) => String(raw[key]).startsWith('replace_with'));
    if (placeholders.length) throw new Error(`Replace production placeholders: ${placeholders.join(', ')}`);
    for (const key of ['REDIS_URL', 'RABBITMQ_URL'] as const) {
      const password = productionConnectionSecret(raw, key);
      if (!password || password === 'food_ordering_dev' || password.startsWith('replace_with')) {
        throw new Error(`${key} must use a production password`);
      }
    }
    if (raw.OTP_DELIVERY_MODE === 'test') throw new Error('Test OTP delivery is not allowed in production');
  }
  const port = Number(raw.API_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT must be a valid port');
  if (Boolean(raw.SMTP_USER) !== Boolean(raw.SMTP_PASSWORD)) {
    throw new Error('SMTP_USER and SMTP_PASSWORD must be configured together');
  }
  return raw;
}
