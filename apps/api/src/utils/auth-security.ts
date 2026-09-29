import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

export interface EncryptedDelivery {
  ciphertext: string;
  nonce: string;
  tag: string;
}

export interface DeliveryPayload {
  destination: string;
  code: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizePhone(phone: string): string {
  return phone.trim();
}

export function normalizeIdentifier(identifier: string): string {
  const value = identifier.trim();
  return value.includes('@') ? normalizeEmail(value) : normalizePhone(value);
}

export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function keyedDigest(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function safeHexEqual(expected: string, actual: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expected) || !/^[a-f0-9]{64}$/i.test(actual)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

export function parseEncryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32 || key.toString('base64') !== base64) {
    throw new Error('OTP_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key');
  }
  return key;
}

export function encryptDelivery(key: Buffer, payload: DeliveryPayload): EncryptedDelivery {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptDelivery(key: Buffer, encrypted: EncryptedDelivery): DeliveryPayload {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encrypted.nonce, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const parsed = JSON.parse(plaintext) as DeliveryPayload;
  if (typeof parsed.destination !== 'string' || !/^\d{6}$/.test(parsed.code)) {
    throw new Error('Invalid OTP delivery payload');
  }
  return parsed;
}
