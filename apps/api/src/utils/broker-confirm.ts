import type { ConfirmChannel } from 'amqplib';

export async function waitForBrokerConfirms(channel: ConfirmChannel): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      channel.waitForConfirms(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // A stuck publisher must not keep a database transaction or consumer
          // slot open indefinitely. The caller retries the durable message.
          void channel.close().catch(() => undefined);
          reject(new Error('BROKER_CONFIRM_TIMEOUT'));
        }, 10_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
