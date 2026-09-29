import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseOptions } from '../config/database.js';
import { validateEnv } from '../config/env.js';
import { QueueWorkerModule } from './queue.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'], validate: validateEnv }),
    TypeOrmModule.forRootAsync({ inject: [ConfigService], useFactory: databaseOptions }),
    QueueWorkerModule,
  ],
})
export class WorkerModule {}
