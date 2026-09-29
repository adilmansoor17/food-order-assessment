import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { normalizeEmail, normalizeIdentifier, normalizePhone } from '../utils/auth-security.js';
import type { OtpChannel } from './auth.types.js';

export class RegisterDto {
  @IsString()
  @Length(1, 160)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name: string;

  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  )
  email: string;

  @Matches(/^\+[1-9][0-9]{7,14}$/, { message: 'phone must be in E.164 format' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizePhone(value) : value,
  )
  phone: string;

  @IsString()
  @Length(10, 72)
  @ApiProperty({ format: 'password', writeOnly: true, minLength: 10, maxLength: 72 })
  password: string;
}

export class PasswordLoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeIdentifier(value) : value,
  )
  identifier: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  @ApiProperty({ format: 'password', writeOnly: true })
  password: string;
}

export class OtpRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeIdentifier(value) : value,
  )
  identifier: string;

  @IsIn(['email', 'phone'])
  channel: OtpChannel;
}

export class OtpVerifyDto {
  @IsUUID('4')
  challengeId: string;

  @Matches(/^\d{6}$/)
  @ApiProperty({ writeOnly: true, pattern: '^\\d{6}$' })
  code: string;
}
