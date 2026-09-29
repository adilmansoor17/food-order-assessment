import { ArgumentsHost, HttpException, HttpStatus, Logger, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { HttpErrorFilter } from './http-exception.filter.js';

describe('HttpErrorFilter', () => {
  it('preserves retry guidance for bounded rate limits', () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ method: 'POST', requestId: 'request-2' }),
      }),
    } as unknown as ArgumentsHost;

    new HttpErrorFilter().catch(
      new HttpException({ code: 'RATE_LIMITED', message: 'Too many attempts', retryAfterSeconds: 30 }, HttpStatus.TOO_MANY_REQUESTS),
      host,
    );

    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.json).toHaveBeenCalledWith({ code: 'RATE_LIMITED', message: 'Too many attempts', requestId: 'request-2' });
  });

  it('hides internal exception text and request query values', () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ method: 'GET', url: '/v1/products?token=secret', requestId: 'request-1' }),
      }),
    } as unknown as ArgumentsHost;

    new HttpErrorFilter().catch(
      new HttpException({ code: 'LEAK', message: 'secret credential' }, HttpStatus.INTERNAL_SERVER_ERROR),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: 'request-1' });
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(log).toHaveBeenCalledWith('GET request request-1 failed: HttpException');
    log.mockRestore();
  });

  it('uses a stable validation code for Nest request DTO failures', () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ method: 'POST', requestId: 'request-3' }),
      }),
    } as unknown as ArgumentsHost;

    new HttpErrorFilter().catch(
      new HttpException({ message: ['quantity must be an integer number'] }, HttpStatus.BAD_REQUEST),
      host,
    );

    expect(response.json).toHaveBeenCalledWith({
      code: 'VALIDATION_ERROR', message: 'quantity must be an integer number', requestId: 'request-3',
    });
  });

  it('logs the safe database cause once without exposing connection text', () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ method: 'POST', requestId: 'request-4' }),
      }),
    } as unknown as ArgumentsHost;
    const cause = Object.assign(new Error('password=private'), { code: '53300' });
    new HttpErrorFilter().catch(new ServiceUnavailableException(
      { code: 'CHECKOUT_UNAVAILABLE', message: 'Try again' }, { cause },
    ), host);

    expect(log).toHaveBeenCalledWith('POST request request-4 failed: Error (53300)');
    expect(response.json).toHaveBeenCalledWith({ code: 'CHECKOUT_UNAVAILABLE', message: 'Try again', requestId: 'request-4' });
    log.mockRestore();
  });
});
