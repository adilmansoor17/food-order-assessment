import type { ConfirmChannel } from 'amqplib';
import { waitForBrokerConfirms } from './broker-confirm.js';

describe('publisher confirmation deadline', () => {
  afterEach(() => vi.useRealTimers());

  it('closes a publisher that does not confirm within ten seconds', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const channel = {
      waitForConfirms: vi.fn(() => new Promise<void>(() => undefined)),
      close,
    } as unknown as ConfirmChannel;
    const rejected = expect(waitForBrokerConfirms(channel)).rejects.toThrow('BROKER_CONFIRM_TIMEOUT');

    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
