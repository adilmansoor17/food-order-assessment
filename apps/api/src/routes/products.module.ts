import { Module } from '@nestjs/common';
import { AuthModule } from './auth.module.js';
import { CatalogCacheService } from '../services/catalog-cache.service.js';
import {
  AdminProductsController,
  AdminVariantsController,
  ProductsController,
} from '../controllers/products.controller.js';
import { ProductsService } from '../services/products.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ProductsController, AdminProductsController, AdminVariantsController],
  providers: [ProductsService, CatalogCacheService],
  exports: [ProductsService],
})
export class ProductsModule {}
