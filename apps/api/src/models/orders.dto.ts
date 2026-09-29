import { IsIn, IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CheckoutDto {
  @IsIn(['cod', 'bank_transfer', 'demo'])
  paymentType!: 'cod' | 'bank_transfer' | 'demo';

  @IsInt()
  @Min(0)
  expectedTotalMinor!: number;
}

export class TransferReferenceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  reference!: string;
}
