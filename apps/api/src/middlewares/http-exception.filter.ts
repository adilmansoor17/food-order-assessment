import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { safeErrorKind } from '../utils/safe-error.js';

type RequestWithId = Request & { requestId?: string };

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<RequestWithId>();
    const status = error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const detail = error instanceof HttpException ? error.getResponse() : undefined;
    const object = typeof detail === 'object' && detail !== null ? detail as Record<string, unknown> : {};
    const suppliedMessage = object.message ?? (typeof detail === 'string' ? detail : undefined);
    const message = status === 500 ? 'Internal server error' : Array.isArray(suppliedMessage) ? suppliedMessage.join('; ') : typeof suppliedMessage === 'string' ? suppliedMessage : 'Request failed';
    const code = status === 500 ? 'INTERNAL_ERROR' : typeof object.code === 'string' ? object.code :
      status === HttpStatus.BAD_REQUEST ? 'VALIDATION_ERROR' : 'REQUEST_ERROR';
    const retryAfterSeconds = object.retryAfterSeconds;
    if (status === HttpStatus.TOO_MANY_REQUESTS && typeof retryAfterSeconds === 'number' &&
        Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
    }
    // Error bodies may describe authentication or account state; intermediaries must not cache them.
    response.setHeader('Cache-Control', 'no-store');
    if (status >= 500) {
      const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
      this.logger.error(`${request.method} request ${request.requestId ?? 'unknown'} failed: ${safeErrorKind(cause)}`);
    }
    response.status(status).json({ code, message, requestId: request.requestId });
  }
}
