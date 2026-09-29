import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { safeErrorKind } from '../utils/safe-error.js';

export const EVENTS_EXCHANGE = 'food.events';
export const RETRY_EXCHANGE = 'food.retry';
export const DEAD_EXCHANGE = 'food.dead';
export const MAIN_QUEUE = 'food.notifications';
export const RETRY_QUEUE = 'food.notifications.retry';
export const DEAD_QUEUE = 'food.notifications.dead';
export const ORDER_MAIN_QUEUE = 'food.orders.process';
export const ORDER_RETRY_QUEUE = 'food.orders.process.retry';
export const ORDER_DEAD_QUEUE = 'food.orders.process.dead';
export const ORDER_ROUTING_KEY = 'orders.process';
export const ORDER_RETRY_ROUTING_KEY = 'orders.process.retry';
export const ORDER_DEAD_ROUTING_KEY = 'orders.process.dead';

@Injectable()
export class BrokerService implements OnModuleDestroy {
  private readonly logger = new Logger(BrokerService.name);
  private connection: ChannelModel | null = null;
  private publisher: ConfirmChannel | null = null;
  private connecting: Promise<ConfirmChannel> | null = null;

  async channel(): Promise<ConfirmChannel> {
    if (this.publisher) return this.publisher;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async consumerChannel(): Promise<ConfirmChannel> {
    await this.channel();
    if (!this.connection) throw new Error('RabbitMQ connection closed during consumer setup');
    const channel = await this.connection.createConfirmChannel();
    await this.declare(channel);
    return channel;
  }

  private async connect(): Promise<ConfirmChannel> {
    const url = process.env.RABBITMQ_URL;
    if (!url) throw new Error('RABBITMQ_URL is required for the queue worker');
    const connection = await amqp.connect(url, { timeout: 10_000 });
    connection.on('error', (error) => this.logger.error(`RabbitMQ connection error: ${safeErrorKind(error)}`));
    connection.on('close', () => {
      this.connection = null;
      this.publisher = null;
    });
    try {
      const channel = await connection.createConfirmChannel();
      channel.on('error', (error) => this.logger.error(`RabbitMQ channel error: ${safeErrorKind(error)}`));
      channel.on('close', () => { if (this.publisher === channel) this.publisher = null; });
      await this.declare(channel);
      this.connection = connection;
      this.publisher = channel;
      return channel;
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  async declare(channel: ConfirmChannel): Promise<void> {
    await channel.assertExchange(EVENTS_EXCHANGE, 'direct', { durable: true });
    await channel.assertExchange(RETRY_EXCHANGE, 'direct', { durable: true });
    await channel.assertExchange(DEAD_EXCHANGE, 'direct', { durable: true });
    await channel.assertQueue(MAIN_QUEUE, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': DEAD_EXCHANGE, 'x-dead-letter-routing-key': 'notifications.dead' },
    });
    await channel.bindQueue(MAIN_QUEUE, EVENTS_EXCHANGE, 'notifications');
    await channel.assertQueue(RETRY_QUEUE, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': EVENTS_EXCHANGE, 'x-dead-letter-routing-key': 'notifications' },
    });
    await channel.bindQueue(RETRY_QUEUE, RETRY_EXCHANGE, 'notifications.retry');
    await channel.assertQueue(DEAD_QUEUE, { durable: true });
    await channel.bindQueue(DEAD_QUEUE, DEAD_EXCHANGE, 'notifications.dead');
    await channel.assertQueue(ORDER_MAIN_QUEUE, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': DEAD_EXCHANGE, 'x-dead-letter-routing-key': ORDER_DEAD_ROUTING_KEY },
    });
    await channel.bindQueue(ORDER_MAIN_QUEUE, EVENTS_EXCHANGE, ORDER_ROUTING_KEY);
    await channel.assertQueue(ORDER_RETRY_QUEUE, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': EVENTS_EXCHANGE, 'x-dead-letter-routing-key': ORDER_ROUTING_KEY },
    });
    await channel.bindQueue(ORDER_RETRY_QUEUE, RETRY_EXCHANGE, ORDER_RETRY_ROUTING_KEY);
    await channel.assertQueue(ORDER_DEAD_QUEUE, { durable: true });
    await channel.bindQueue(ORDER_DEAD_QUEUE, DEAD_EXCHANGE, ORDER_DEAD_ROUTING_KEY);
  }

  async reset(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.publisher = null;
    if (connection) await connection.close().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.reset();
  }
}
