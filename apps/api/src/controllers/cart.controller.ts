import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Param,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../middlewares/auth.guard.js';
import { PutCartItemDto } from '../models/cart.dto.js';
import { CartService, parseCartVersion } from '../services/cart.service.js';
import { ApiErrorDto, CartViewDto } from '../models/api-response.dto.js';

type CustomerRequest = Request & { user: { id: string } };

@Controller('cart')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@ApiTags('Cart')
@ApiResponse({ status: 'default', type: ApiErrorDto })
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: CartViewDto, headers: { ETag: { description: 'Quoted cart version', schema: { type: 'string' } } } })
  async get(@Req() request: CustomerRequest, @Res({ passthrough: true }) response: Response) {
    const cart = await this.cart.get(request.user.id);
    response.setHeader('ETag', `"${cart.version}"`);
    return cart;
  }

  @Put('items/:variantId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Set a variant quantity', description: 'Send the current cart version in If-Match. A stale version returns 412.' })
  @ApiOkResponse({ type: CartViewDto, headers: { ETag: { description: 'New quoted cart version', schema: { type: 'string' } } } })
  @ApiResponse({ status: 412, type: ApiErrorDto, description: 'The cart version changed.' })
  @ApiResponse({ status: 428, type: ApiErrorDto, description: 'If-Match is required.' })
  async put(
    @Req() request: CustomerRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('variantId') variantId: string,
    @Body() body: PutCartItemDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    const cart = await this.cart.putItem(request.user.id, variantId, body.quantity, parseCartVersion(ifMatch));
    response.setHeader('ETag', `"${cart.version}"`);
    return cart;
  }

  @Delete('items/:variantId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Remove a variant from the cart', description: 'Send the current cart version in If-Match.' })
  @ApiOkResponse({ type: CartViewDto, headers: { ETag: { description: 'Current quoted cart version', schema: { type: 'string' } } } })
  @ApiResponse({ status: 412, type: ApiErrorDto, description: 'The cart version changed.' })
  @ApiResponse({ status: 428, type: ApiErrorDto, description: 'If-Match is required.' })
  async remove(
    @Req() request: CustomerRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('variantId') variantId: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const cart = await this.cart.removeItem(request.user.id, variantId, parseCartVersion(ifMatch));
    response.setHeader('ETag', `"${cart.version}"`);
    return cart;
  }
}
