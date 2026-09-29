import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApiErrorDto, LiveHealthDto, ReadyHealthDto } from '../models/api-response.dto.js';

@ApiTags('health')
@Controller('health')
@ApiResponse({ status: 'default', type: ApiErrorDto })
export class HealthController {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  @Get('live')
  @ApiOkResponse({ type: LiveHealthDto })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOkResponse({ type: ReadyHealthDto })
  async ready() {
    try {
      await this.db.query('SELECT 1');
      return { status: 'ok', database: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ code: 'DATABASE_UNAVAILABLE', message: 'Database is unavailable' });
    }
  }
}
