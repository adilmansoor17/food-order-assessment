import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// Prices are PKR minor units. This bound also keeps cart arithmetic safe in JSON.
export const MAX_PRICE_MINOR = 100_000_000_000;

export class CreateVariantDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsString()
  @Length(1, 80)
  sku!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_PRICE_MINOR)
  priceMinor!: number;

  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  initialStock!: number;
}

export class CreateProductDto {
  @IsString()
  @Length(1, 160)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @IsBoolean()
  @IsOptional()
  active?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants!: CreateVariantDto[];
}

export class UpdateProductDto {
  @IsString()
  @Length(1, 160)
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @IsBoolean()
  @IsOptional()
  active?: boolean;
}

export class AddVariantDto extends CreateVariantDto {}

export class UpdateVariantDto {
  @IsString()
  @Length(1, 120)
  @IsOptional()
  name?: string;

  @IsString()
  @Length(1, 80)
  @IsOptional()
  sku?: string;

  @IsInt()
  @Min(1)
  @Max(MAX_PRICE_MINOR)
  @IsOptional()
  priceMinor?: number;

  @IsBoolean()
  @IsOptional()
  active?: boolean;
}

export class AdjustStockDto {
  @IsInt()
  @Min(-1_000_000_000)
  @Max(1_000_000_000)
  delta!: number;

  @IsString()
  @IsNotEmpty()
  @Length(1, 500)
  reason!: string;
}
