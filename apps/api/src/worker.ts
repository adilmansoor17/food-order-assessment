import { NestFactory } from '@nestjs/core';
import { createServer } from 'node:http';
import { WorkerModule } from './routes/worker.module.js';
import { NotificationConsumerService } from './services/notification-consumer.service.js';
import { OrderProcessingConsumerService } from './services/order-processing-consumer.service.js';

const worker = await NestFactory.createApplicationContext(WorkerModule);
worker.enableShutdownHooks();
const notifications = worker.get(NotificationConsumerService);
const orders = worker.get(OrderProcessingConsumerService);
const health = createServer((request, response) => {
  if (request.url !== '/health') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(notifications.connected && orders.connected ? 200 : 503).end();
});
await new Promise<void>((resolve, reject) => {
  health.once('error', reject);
  health.listen(3002, '127.0.0.1', resolve);
});
process.once('SIGTERM', () => health.close());
process.once('SIGINT', () => health.close());
