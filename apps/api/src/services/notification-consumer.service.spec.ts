import { Logger } from '@nestjs/common';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { BrokerService } from './broker.service.js';
import { DEAD_EXCHANGE, RETRY_EXCHANGE } from './broker.service.js';
import { NotificationConsumerService } from './notification-consumer.service.js';
import type { OtpDeliveryService } from './otp-delivery.service.js';
import type { OrderEmailService } from './order-email.service.js';

function fixture(database: DataSource) {
  const publish = vi.fn();
  const waitForConfirms = vi.fn(async () => undefined);
  const ack = vi.fn();
  const publisher = { publish, waitForConfirms } as unknown as ConfirmChannel;
  const channel = { ack } as unknown as ConfirmChannel;
  const broker = { channel: vi.fn(async () => publisher) } as unknown as BrokerService;
  const consumer = new NotificationConsumerService(database, broker, {} as OtpDeliveryService, {} as OrderEmailService);
  const handle = (message: ConsumeMessage) => (consumer as unknown as {
    handle(channel: ConfirmChannel, message: ConsumeMessage): Promise<void>;
  }).handle(channel, message);
  return { publish, waitForConfirms, ack, handle };
}

function delivery(content: Buffer): ConsumeMessage {
  return { content, properties: { headers: {}, messageId: 'not-a-uuid\nsecret' } } as ConsumeMessage;
}

describe('NotificationConsumerService retry decisions', () => {
  it('dead-letters malformed immutable events after broker confirmation', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { publish, waitForConfirms, ack, handle } = fixture({} as DataSource);
      const message = delivery(Buffer.from('{'));
      await handle(message);

      expect(publish).toHaveBeenCalledWith(DEAD_EXCHANGE, 'notifications.dead', message.content,
        expect.objectContaining({ type: 'invalid', headers: { attempts: 1, reason: 'INVALID_EVENT' } }));
      expect(waitForConfirms).toHaveBeenCalledOnce();
      expect(ack).toHaveBeenCalledWith(message);
      expect(waitForConfirms.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
      expect(log.mock.calls[0][0]).not.toContain('secret');
    } finally {
      log.mockRestore();
    }
  });

  it('retries transient database failure and releases the failed runner', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const runner = {
        connect: vi.fn().mockRejectedValue(new Error('database unavailable')),
        release: vi.fn(async () => undefined),
        rollbackTransaction: vi.fn(async () => undefined),
      };
      const { publish, ack, handle } = fixture({ createQueryRunner: () => runner } as unknown as DataSource);
      const challengeId = randomUUID();
      const message = delivery(Buffer.from(JSON.stringify({
        eventId: randomUUID(), eventType: 'otp.send', aggregateId: challengeId,
        payload: { challengeId }, createdAt: new Date().toISOString(),
      })));
      await handle(message);

      expect(publish).toHaveBeenCalledWith(RETRY_EXCHANGE, 'notifications.retry', message.content,
        expect.objectContaining({ headers: { attempts: 1, reason: 'DELIVERY_ERROR' }, expiration: '1000' }));
      expect(runner.release).toHaveBeenCalledOnce();
      expect(runner.rollbackTransaction).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith(message);
    } finally {
      log.mockRestore();
    }
  });
});
