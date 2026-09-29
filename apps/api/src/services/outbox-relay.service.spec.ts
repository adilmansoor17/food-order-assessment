import type { DataSource } from 'typeorm';
import type { BrokerService } from './broker.service.js';
import { OutboxRelayService } from './outbox-relay.service.js';

const EVENT_ID = '45712333-bea6-4e23-9e0b-f82fa738e965';
const ORDER_ID = '0185353e-3876-4ff5-b277-62a2049ef060';
const event = {
  id: EVENT_ID,
  event_type: 'order.placed',
  aggregate_id: ORDER_ID,
  payload: { orderId: ORDER_ID },
  attempts: 0,
  created_at: new Date('2026-09-29T10:00:00.000Z'),
};

function relay(confirm: () => Promise<void>) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => sql.includes('SELECT id, event_type') ? [event] : []);
  const runner = {
    isTransactionActive: true,
    connect: vi.fn(async () => undefined),
    startTransaction: vi.fn(async () => undefined),
    commitTransaction: vi.fn(async () => { runner.isTransactionActive = false; }),
    rollbackTransaction: vi.fn(async () => { runner.isTransactionActive = false; }),
    release: vi.fn(async () => undefined),
    query,
  };
  const channel = { publish: vi.fn(), waitForConfirms: vi.fn(confirm) };
  const reset = vi.fn(async () => undefined);
  const broker = {
    channel: vi.fn(async () => channel),
    reset,
  } as unknown as BrokerService;
  const source = { createQueryRunner: () => runner } as unknown as DataSource;
  return { service: new OutboxRelayService(source, broker), runner, query, channel, reset };
}

describe('OutboxRelayService', () => {
  it('marks an outbox event sent only after broker confirmation', async () => {
    const { service, runner, query, channel } = relay(async () => undefined);
    expect(await service.dispatch()).toBe(1);
    expect(channel.publish).toHaveBeenCalledOnce();
    expect(channel.waitForConfirms).toHaveBeenCalledOnce();
    expect(query.mock.calls.find(([sql]) => sql.includes('UPDATE outbox'))?.[1]).toEqual([[EVENT_ID], 'sent']);
    expect(runner.commitTransaction).toHaveBeenCalledOnce();
  });

  it('rolls back without marking sent when RabbitMQ does not confirm', async () => {
    const { service, runner, query, reset } = relay(async () => { throw new Error('broker unavailable'); });
    await expect(service.dispatch()).rejects.toThrow('broker unavailable');
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE outbox'))).toBe(false);
    expect(runner.rollbackTransaction).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
  });

  it('drains another batch immediately when full, then waits when empty', async () => {
    vi.useFakeTimers();
    const { service, query, channel } = relay(async () => undefined);
    const fullBatch = Array.from({ length: 100 }, (_, index) => ({
      ...event,
      id: `45712333-bea6-4e23-9e0b-${String(index).padStart(12, '0')}`,
    }));
    let reads = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, event_type')) {
        reads += 1;
        return reads === 1 ? fullBatch : [];
      }
      return [];
    });
    try {
      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(2);
      expect(channel.publish).toHaveBeenCalledTimes(100);
      expect(channel.waitForConfirms).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(999);
      expect(reads).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads).toBe(3);
    } finally {
      await service.onModuleDestroy();
      vi.useRealTimers();
    }
  });
});
