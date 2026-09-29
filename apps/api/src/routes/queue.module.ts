import { Module } from '@nestjs/common';
import { AuthModule } from './auth.module.js';
import { BrokerService } from '../services/broker.service.js';
import { AuthMaintenanceService } from '../services/auth-maintenance.service.js';
import { FulfillmentService } from '../services/fulfillment.service.js';
import { OrderProcessingConsumerService } from '../services/order-processing-consumer.service.js';
import { NotificationConsumerService } from '../services/notification-consumer.service.js';
import { OrderEmailService } from '../services/order-email.service.js';
import { OutboxRelayService } from '../services/outbox-relay.service.js';

// Import in the worker entrypoint only. HTTP requests merely persist outbox rows.
@Module({
  imports: [AuthModule],
  providers: [BrokerService, OutboxRelayService, NotificationConsumerService, OrderEmailService, AuthMaintenanceService, FulfillmentService, OrderProcessingConsumerService],
  exports: [BrokerService, OutboxRelayService, FulfillmentService],
})
export class QueueWorkerModule {}
