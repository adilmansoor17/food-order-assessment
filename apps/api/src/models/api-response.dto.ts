import { ApiProperty } from '@nestjs/swagger';

const uuid = { type: String, format: 'uuid' } as const;
const dateTime = { type: String, format: 'date-time' } as const;
const optionalDateTime = { ...dateTime, nullable: true } as const;

/** HTTP response shapes only. These classes do not serialize database rows. */
export class ApiErrorDto {
  @ApiProperty({ example: 'CART_VERSION_CONFLICT' }) code!: string;
  @ApiProperty({ example: 'Cart changed; refresh and retry' }) message!: string;
  @ApiProperty(uuid) requestId!: string;
}

export class PublicUserDto {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty({ description: 'E.164 phone number' }) phone!: string;
  @ApiProperty({ enum: ['customer', 'admin'] }) role!: 'customer' | 'admin';
}

export class SessionDto {
  @ApiProperty({ type: () => PublicUserDto }) user!: PublicUserDto;
  @ApiProperty({ description: 'Short-lived bearer token. The refresh token is only set as an HttpOnly cookie.' }) accessToken!: string;
  @ApiProperty(dateTime) accessExpiresAt!: string;
}

export class RefreshSessionDto {
  @ApiProperty({ description: 'New short-lived bearer token' }) accessToken!: string;
  @ApiProperty(dateTime) accessExpiresAt!: string;
}

export class OtpChallengeDto {
  @ApiProperty(uuid) challengeId!: string;
  @ApiProperty({ type: 'integer', example: 300 }) expiresInSeconds!: number;
}

export class PublicVariantDto {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: 'integer', description: 'PKR paisa, calculated by the server' }) priceMinor!: number;
  @ApiProperty({ enum: ['PKR'] }) currency!: 'PKR';
  @ApiProperty() available!: boolean;
}

export class PublicProductDto {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: () => PublicVariantDto, isArray: true }) variants!: PublicVariantDto[];
}

export class PublicProductPageDto {
  @ApiProperty({ type: () => PublicProductDto, isArray: true }) items!: PublicProductDto[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) nextCursor!: string | null;
}

export class AdminVariantDto {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) productId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() sku!: string;
  @ApiProperty({ type: 'integer', description: 'PKR paisa' }) priceMinor!: number;
  @ApiProperty({ enum: ['PKR'] }) currency!: 'PKR';
  @ApiProperty({ type: 'integer' }) stock!: number;
  @ApiProperty() active!: boolean;
  @ApiProperty(dateTime) createdAt!: string;
  @ApiProperty(dateTime) updatedAt!: string;
}

export class AdminProductDto {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() description!: string;
  @ApiProperty() active!: boolean;
  @ApiProperty(optionalDateTime) archivedAt!: string | null;
  @ApiProperty({ type: () => AdminVariantDto, isArray: true }) variants!: AdminVariantDto[];
  @ApiProperty(dateTime) createdAt!: string;
  @ApiProperty(dateTime) updatedAt!: string;
}

export class AdminProductPageDto {
  @ApiProperty({ type: () => AdminProductDto, isArray: true }) items!: AdminProductDto[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) nextCursor!: string | null;
}

export class CartItemDto {
  @ApiProperty(uuid) productId!: string;
  @ApiProperty(uuid) variantId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() productName!: string;
  @ApiProperty() variantName!: string;
  @ApiProperty({ type: 'integer' }) quantity!: number;
  @ApiProperty({ type: 'integer', description: 'PKR paisa' }) unitPriceMinor!: number;
  @ApiProperty({ type: 'integer', description: 'PKR paisa' }) lineTotalMinor!: number;
  @ApiProperty() available!: boolean;
}

export class CartViewDto {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) userId!: string;
  @ApiProperty({ type: 'integer', description: 'Send this version in If-Match when editing the cart or checking out' }) version!: number;
  @ApiProperty({ type: () => CartItemDto, isArray: true }) items!: CartItemDto[];
  @ApiProperty({ type: 'integer', description: 'Estimated PKR paisa; checkout rechecks current prices' }) totalMinor!: number;
  @ApiProperty({ type: 'integer', description: 'Same estimate as totalMinor' }) estimatedTotalMinor!: number;
  @ApiProperty({ enum: ['PKR'] }) currency!: 'PKR';
}

export class OrderItemDto {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) productId!: string;
  @ApiProperty(uuid) variantId!: string;
  @ApiProperty() productName!: string;
  @ApiProperty() variantName!: string;
  @ApiProperty({ type: 'integer' }) quantity!: number;
  @ApiProperty({ type: 'integer', description: 'Committed PKR paisa' }) unitPriceMinor!: number;
  @ApiProperty({ type: 'integer', description: 'Committed PKR paisa' }) lineTotalMinor!: number;
}

export class OrderViewDto {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ enum: ['pending', 'paid', 'cancelled'] }) status!: 'pending' | 'paid' | 'cancelled';
  @ApiProperty({ enum: ['cod', 'bank_transfer', 'demo'] }) paymentType!: 'cod' | 'bank_transfer' | 'demo';
  @ApiProperty({ enum: ['pending', 'paid'] }) paymentStatus!: 'pending' | 'paid';
  @ApiProperty({ enum: ['queued', 'ready', 'failed', 'cancelled'] }) fulfillmentStatus!: 'queued' | 'ready' | 'failed' | 'cancelled';
  @ApiProperty(dateTime) fulfillmentUpdatedAt!: string;
  @ApiProperty({ type: 'integer', description: 'Committed PKR paisa' }) totalMinor!: number;
  @ApiProperty({ enum: ['PKR'] }) currency!: 'PKR';
  @ApiProperty({ type: String, nullable: true, description: 'Customer-provided bank transfer reference; not proof of payment' }) transferReference!: string | null;
  @ApiProperty(dateTime) createdAt!: string;
  @ApiProperty(dateTime) updatedAt!: string;
  @ApiProperty(optionalDateTime) paidAt!: string | null;
  @ApiProperty(optionalDateTime) cancelledAt!: string | null;
  @ApiProperty({ type: () => OrderItemDto, isArray: true }) items!: OrderItemDto[];
}

export class OrderPageDto {
  @ApiProperty({ type: () => OrderViewDto, isArray: true }) items!: OrderViewDto[];
  @ApiProperty({ type: String, nullable: true, description: 'Opaque pagination cursor' }) nextCursor!: string | null;
}

export class OrderStatusDto {
  @ApiProperty({ enum: ['pending', 'paid', 'cancelled'] }) status!: 'pending' | 'paid' | 'cancelled';
  @ApiProperty({ enum: ['pending', 'paid'] }) paymentStatus!: 'pending' | 'paid';
  @ApiProperty({ enum: ['queued', 'ready', 'failed', 'cancelled'] }) fulfillmentStatus!: 'queued' | 'ready' | 'failed' | 'cancelled';
  @ApiProperty(dateTime) fulfillmentUpdatedAt!: string;
  @ApiProperty(dateTime) updatedAt!: string;
}

export class BankTransferDto {
  @ApiProperty() bankName!: string;
  @ApiProperty() accountName!: string;
  @ApiProperty() iban!: string;
}

export class CheckoutConfigDto {
  @ApiProperty({ enum: ['PKR'] }) currency!: 'PKR';
  @ApiProperty({ type: () => BankTransferDto, nullable: true }) bankTransfer!: BankTransferDto | null;
  @ApiProperty({ description: 'Only true outside production when local simulation is explicitly enabled' }) demoPaymentsEnabled!: boolean;
}

export class LiveHealthDto {
  @ApiProperty({ enum: ['ok'] }) status!: 'ok';
}

export class ReadyHealthDto extends LiveHealthDto {
  @ApiProperty({ enum: ['ok'] }) database!: 'ok';
}
