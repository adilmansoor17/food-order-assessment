import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseOptions } from '../config/database.js';
import { validateEnv } from '../config/env.js';
import { HealthController } from '../controllers/health.controller.js';
import { CheckoutConfigController } from '../controllers/checkout-config.controller.js';
import { AuthModule } from './auth.module.js';
import { ProductsModule } from './products.module.js';
import { CartModule } from './cart.module.js';
import { OrdersModule } from './orders.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'], validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: databaseOptions,
    }),
    AuthModule,
    ProductsModule,
    CartModule,
    OrdersModule,
  ],
  controllers: [HealthController, CheckoutConfigController],
})
export class AppModule {}
