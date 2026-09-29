import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { capacityLimit } from '../config/capacity.js';
import { AdminGuard, JwtAuthGuard } from '../middlewares/auth.guard.js';
import type { AuthUser } from '../models/user.types.js';
import { CheckoutDto, TransferReferenceDto } from '../models/orders.dto.js';
import { OrdersService } from '../services/orders.service.js';
import { OrderRateLimitService } from '../services/order-rate-limit.service.js';
import { ApiErrorDto, OrderPageDto, OrderStatusDto, OrderViewDto } from '../models/api-response.dto.js';

type AuthenticatedRequest = Request & { user: AuthUser };

const RETRYABLE_DATABASE_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH',
  '08000', '08001', '08003', '08006', '53300', '57P01', '57P02', '57P03',
  '40001', '40P01',
]);

function databaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === 'timeout exceeded when trying to connect' ||
      error.message === 'Connection terminated due to connection timeout') return true;
  const candidate = error as Error & { code?: unknown; driverError?: { code?: unknown } };
  const code = candidate.driverError?.code ?? candidate.code;
  // These failures happen before or during checkout commit. The idempotency key
  // lets the client resolve an ambiguous result with the same request.
  return typeof code === 'string' && RETRYABLE_DATABASE_CODES.has(code);
}

@Controller('orders')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@ApiTags('Orders')
@ApiResponse({ status: 'default', type: ApiErrorDto, description: 'Stable error code, safe message, and request ID.' })
@ApiResponse({ status: 429, type: ApiErrorDto, description: 'Per-account order request limit.', headers: { 'Retry-After': { description: 'Wait time in seconds', schema: { type: 'integer' } } } })
export class OrdersController {
  private readonly maxInFlight = capacityLimit('CHECKOUT_MAX_IN_FLIGHT', 32, 512);
  private inFlight = 0;

  constructor(private readonly orders: OrdersService, private readonly rateLimits: OrderRateLimitService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID identifying this checkout attempt' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Current numeric cart version' })
  @ApiOperation({ summary: 'Commit an order from the current cart', description: 'Commits stock, order, fulfillment task, and outbox atomically. The response starts queued/pending; a worker updates fulfillment later. Reuse the same key and request after a network timeout.' })
  @ApiCreatedResponse({ type: OrderViewDto })
  @ApiResponse({ status: 409, type: ApiErrorDto, description: 'Price, stock, cart, or idempotency conflict.' })
  @ApiResponse({ status: 412, type: ApiErrorDto, description: 'Cart version changed; fetch the cart before a new attempt.' })
  @ApiResponse({ status: 503, type: ApiErrorDto, description: 'Capacity or transient database failure. Retry the identical request with the same key.', headers: { 'Retry-After': { description: 'Wait time in seconds', schema: { type: 'integer' } } } })
  async checkout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: CheckoutDto,
  ) {
    if (this.inFlight >= this.maxInFlight) {
      response.setHeader('Retry-After', '1');
      throw new ServiceUnavailableException({ code: 'CHECKOUT_BUSY', message: 'Checkout is busy; retry with the same idempotency key' });
    }
    this.inFlight += 1;
    try {
      // A completed checkout can always be resolved with its original key,
      // even when the account has reached the new-attempt limit.
      if (await this.orders.isCheckoutReplay(req.user.id, idempotencyKey)) {
        await this.rateLimits.read(req.user.id);
      } else {
        await this.rateLimits.checkout(req.user.id);
      }
      return await this.orders.checkout(req.user, idempotencyKey, ifMatch, body);
    } catch (error) {
      if (databaseUnavailable(error)) {
        response.setHeader('Retry-After', '1');
        throw new ServiceUnavailableException(
          { code: 'CHECKOUT_UNAVAILABLE', message: 'Checkout is temporarily unavailable; retry with the same idempotency key' },
          { cause: error },
        );
      }
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: OrderPageDto })
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    await this.rateLimits.read(req.user.id);
    return this.orders.list(req.user, cursor, limit);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: OrderViewDto })
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.rateLimits.read(req.user.id);
    return this.orders.get(req.user, id);
  }

  @Get(':id/status')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read current payment and fulfillment status', description: 'Use this for polling after checkout; payment and fulfillment are separate states.' })
  @ApiOkResponse({ type: OrderStatusDto })
  async status(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.rateLimits.read(req.user.id);
    return this.orders.status(req.user, id);
  }

  @Put(':id/transfer-reference')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Submit a bank transfer reference', description: 'A reference is a customer claim and does not mark payment as paid.' })
  @ApiOkResponse({ type: OrderViewDto })
  async transferReference(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: TransferReferenceDto,
  ) {
    await this.rateLimits.customerChange(req.user.id);
    const reference = body.reference.trim();
    if (!reference) {
      throw new BadRequestException({ code: 'INVALID_REFERENCE', message: 'A transfer reference is required' });
    }
    return this.orders.updateTransferReference(req.user, id, reference);
  }
}

@Controller('admin/orders')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
@ApiTags('Admin orders')
@ApiResponse({ status: 'default', type: ApiErrorDto })
@ApiResponse({ status: 429, type: ApiErrorDto, description: 'Per-admin order request limit.', headers: { 'Retry-After': { description: 'Wait time in seconds', schema: { type: 'integer' } } } })
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService, private readonly rateLimits: OrderRateLimitService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: OrderPageDto })
  async list(@Req() req: AuthenticatedRequest, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    await this.rateLimits.read(req.user.id);
    return this.orders.listAdmin(cursor, limit);
  }

  @Post(':id/mark-paid')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Record verified COD or bank payment', description: 'Requires admin role and ready fulfillment. Demo payment settles automatically in the worker.' })
  @ApiCreatedResponse({ type: OrderViewDto })
  async markPaid(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.rateLimits.adminChange(req.user.id);
    return this.orders.markPaid(req.user, id);
  }

  @Post(':id/cancel')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Cancel an unpaid order and restore stock once' })
  @ApiCreatedResponse({ type: OrderViewDto })
  async cancel(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.rateLimits.adminChange(req.user.id);
    return this.orders.cancel(req.user, id);
  }
}
