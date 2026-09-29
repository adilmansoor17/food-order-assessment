import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController, MeController } from '../controllers/auth.controller.js';
import { AdminGuard, JwtAuthGuard } from '../middlewares/auth.guard.js';
import { AuthService } from '../services/auth.service.js';
import { OtpDeliveryService } from '../services/otp-delivery.service.js';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController, MeController],
  providers: [AuthService, OtpDeliveryService, JwtAuthGuard, AdminGuard],
  exports: [JwtModule, AuthService, OtpDeliveryService, JwtAuthGuard, AdminGuard],
})
export class AuthModule {}
