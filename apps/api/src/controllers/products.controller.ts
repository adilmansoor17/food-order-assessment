import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AdminGuard, JwtAuthGuard } from '../middlewares/auth.guard.js';
import {
  AddVariantDto,
  AdjustStockDto,
  CreateProductDto,
  UpdateProductDto,
  UpdateVariantDto,
} from '../models/products.dto.js';
import { ProductsService } from '../services/products.service.js';
import { AdminProductDto, AdminProductPageDto, AdminVariantDto, ApiErrorDto, PublicProductDto, PublicProductPageDto } from '../models/api-response.dto.js';

type AdminRequest = Request & { user: { id: string } };

@Controller('products')
@ApiTags('Catalog')
@ApiResponse({ status: 'default', type: ApiErrorDto })
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @ApiOperation({ summary: 'List active menu products', description: 'Only display fields are exposed; stock counts and SKUs are admin-only.' })
  @ApiOkResponse({ type: PublicProductPageDto })
  list(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.products.list(cursor, limit);
  }

  @Get(':id')
  @ApiOkResponse({ type: PublicProductDto })
  get(@Param('id') id: string) {
    return this.products.get(id);
  }
}

@Controller('admin/products')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
@ApiTags('Admin catalog')
@ApiResponse({ status: 'default', type: ApiErrorDto })
export class AdminProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: AdminProductPageDto })
  list(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.products.listAdmin(cursor, limit);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: AdminProductDto })
  get(@Param('id') id: string) {
    return this.products.get(id, true);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ type: AdminProductDto })
  create(@Body() body: CreateProductDto, @Req() request: AdminRequest) {
    return this.products.create(body, request.user.id);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: AdminProductDto })
  update(@Param('id') id: string, @Body() body: UpdateProductDto, @Req() request: AdminRequest) {
    return this.products.update(id, body, request.user.id);
  }

  @Delete(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Archive a product while preserving order history' })
  @ApiOkResponse({ type: AdminProductDto })
  archive(@Param('id') id: string, @Req() request: AdminRequest) {
    return this.products.archive(id, request.user.id);
  }

  @Post(':id/variants')
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ type: AdminVariantDto })
  addVariant(@Param('id') id: string, @Body() body: AddVariantDto, @Req() request: AdminRequest) {
    return this.products.addVariant(id, body, request.user.id);
  }
}

@Controller('admin/variants')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
@ApiTags('Admin catalog')
@ApiResponse({ status: 'default', type: ApiErrorDto })
export class AdminVariantsController {
  constructor(private readonly products: ProductsService) {}

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: AdminVariantDto })
  update(@Param('id') id: string, @Body() body: UpdateVariantDto, @Req() request: AdminRequest) {
    return this.products.updateVariant(id, body, request.user.id);
  }

  @Delete(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Disable a variant without deleting past order lines' })
  @ApiOkResponse({ type: AdminVariantDto })
  archive(@Param('id') id: string, @Req() request: AdminRequest) {
    return this.products.archiveVariant(id, request.user.id);
  }

  @Post(':id/stock-adjustments')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Apply and audit a stock adjustment' })
  @ApiCreatedResponse({ type: AdminVariantDto })
  adjustStock(@Param('id') id: string, @Body() body: AdjustStockDto, @Req() request: AdminRequest) {
    return this.products.adjustStock(id, body, request.user.id);
  }
}
