import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrorDto, CheckoutConfigDto } from '../models/api-response.dto.js';

@Controller('config/checkout')
@ApiTags('Checkout configuration')
@ApiResponse({ status: 'default', type: ApiErrorDto })
export class CheckoutConfigController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @ApiOkResponse({ type: CheckoutConfigDto })
  get() {
    const bankName = this.config.get<string>('BANK_NAME')?.trim() ?? '';
    const accountName = this.config.get<string>('BANK_ACCOUNT_NAME')?.trim() ?? '';
    const iban = this.config.get<string>('BANK_IBAN')?.trim() ?? '';
    return {
      currency: 'PKR' as const,
      bankTransfer: bankName && accountName && iban ? { bankName, accountName, iban } : null,
      demoPaymentsEnabled: this.config.get<string>('NODE_ENV') !== 'production' &&
        this.config.get<string>('DEMO_PAYMENTS_ENABLED') === 'true',
    };
  }
}
