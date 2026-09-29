import { Module } from '@nestjs/common';
import { AuthModule } from './auth.module.js';
import { CartController } from '../controllers/cart.controller.js';
import { CartService } from '../services/cart.service.js';

@Module({
  imports: [AuthModule],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
