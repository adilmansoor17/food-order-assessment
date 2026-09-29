import { Module } from '@nestjs/common';
import { AuthModule } from './auth.module.js';
import { AdminOrdersController, OrdersController } from '../controllers/orders.controller.js';
import { OrdersService } from '../services/orders.service.js';
import { OrderRateLimitService } from '../services/order-rate-limit.service.js';

@Module({
  imports: [AuthModule],
  controllers: [OrdersController, AdminOrdersController],
  providers: [OrdersService, OrderRateLimitService],
  exports: [OrdersService],
})
export class OrdersModule {}
