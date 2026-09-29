import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { AppModule } from './routes/app.module.js';
import { HttpErrorFilter } from './middlewares/http-exception.filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  if (process.env.NODE_ENV === 'production') {
    // Production Compose exposes this API only through one Caddy hop.
    const expressApp = app.getHttpAdapter().getInstance() as { set(name: string, value: number): void };
    expressApp.set('trust proxy', 1);
  }
  app.setGlobalPrefix('v1');
  app.use(cookieParser());
  app.use((request: { requestId?: string }, response: { setHeader(name: string, value: string): void }, next: () => void) => {
    request.requestId = randomUUID();
    response.setHeader('X-Request-Id', request.requestId);
    next();
  });
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpErrorFilter());
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Food Ordering API')
    .setDescription('Version 1 API for food ordering and administration')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  await app.listen(process.env.API_PORT ?? 3001, '0.0.0.0');
}
await bootstrap();
