import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middlewares/auth.guard.js';
import { JwtAuthGuard } from '../middlewares/auth.guard.js';
import {
  OtpRequestDto,
  OtpVerifyDto,
  PasswordLoginDto,
  RegisterDto,
} from '../models/auth.dto.js';
import { AuthService } from '../services/auth.service.js';
import type { AuthSessionResult } from '../models/auth.types.js';
import { ApiErrorDto, OtpChallengeDto, PublicUserDto, RefreshSessionDto, SessionDto } from '../models/api-response.dto.js';

const REFRESH_COOKIE = 'fo_refresh';

function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}

function cookieValue(request: Request, name: string): string | undefined {
  const pair = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!pair) return undefined;
  try {
    return decodeURIComponent(pair.slice(name.length + 1));
  } catch {
    return undefined;
  }
}

@Controller('auth')
@ApiTags('Authentication')
@ApiResponse({ status: 'default', type: ApiErrorDto, description: 'Error code, safe message, and request ID. Rate limits also set Retry-After.' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.get<string>('NODE_ENV') === 'production',
      sameSite: 'lax' as const,
      path: '/v1/auth',
    };
  }

  private setSession(response: Response, session: AuthSessionResult) {
    response.cookie(REFRESH_COOKIE, session.refreshToken, {
      ...this.cookieOptions(),
      maxAge: this.auth.refreshTtlSeconds * 1000,
    });
    response.setHeader('Cache-Control', 'no-store');
    return {
      user: session.user,
      accessToken: session.accessToken,
      accessExpiresAt: session.accessExpiresAt,
    };
  }

  private assertCookieOrigin(request: Request): void {
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw new ForbiddenException({ code: 'FORBIDDEN_ORIGIN', message: 'Forbidden origin' });
    }
    const origin = request.headers.origin;
    if (!origin) return;
    const webOrigin = this.config.get<string>('WEB_ORIGIN');
    const host = request.headers.host;
    let sameApiHost = false;
    try {
      const parsed = new URL(origin);
      sameApiHost = parsed.host === host && parsed.protocol === `${request.protocol}:`;
    } catch {
      // A malformed Origin is forbidden below.
    }
    if (!sameApiHost && origin !== webOrigin) {
      throw new ForbiddenException({ code: 'FORBIDDEN_ORIGIN', message: 'Forbidden origin' });
    }
  }

  @Post('register')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Register a customer and start a session' })
  @ApiCreatedResponse({ type: SessionDto, description: 'Access token in JSON; rotating refresh token in an HttpOnly cookie.' })
  @ApiResponse({ status: 429, type: ApiErrorDto, headers: { 'Retry-After': { description: 'Wait time in seconds', schema: { type: 'integer' } } } })
  async register(
    @Body() input: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.assertCookieOrigin(request);
    const session = await this.auth.register(input, clientIp(request));
    return this.setSession(response, session);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Sign in with email or phone and password' })
  @ApiOkResponse({ type: SessionDto })
  @ApiResponse({ status: 429, type: ApiErrorDto, headers: { 'Retry-After': { description: 'Wait time in seconds', schema: { type: 'integer' } } } })
  async login(
    @Body() input: PasswordLoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.assertCookieOrigin(request);
    const session = await this.auth.passwordLogin(
      input.identifier,
      input.password,
      clientIp(request),
    );
    return this.setSession(response, session);
  }

  @Post('otp/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Request a passwordless login code', description: 'The response has the same shape for known and unknown identities. A code is delivered only for an eligible account.' })
  @ApiResponse({ status: HttpStatus.ACCEPTED, type: OtpChallengeDto })
  @ApiResponse({ status: 429, type: ApiErrorDto, headers: { 'Retry-After': { description: 'Wait time in seconds', schema: { type: 'integer' } } } })
  requestLoginOtp(@Body() input: OtpRequestDto, @Req() request: Request) {
    this.assertCookieOrigin(request);
    return this.auth.requestLoginOtp(input.identifier, input.channel, clientIp(request));
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Exchange a one-time code for a session' })
  @ApiOkResponse({ type: SessionDto })
  @ApiResponse({ status: 429, type: ApiErrorDto, headers: { 'Retry-After': { description: 'Wait time in seconds', schema: { type: 'integer' } } } })
  async verifyLoginOtp(
    @Body() input: OtpVerifyDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.assertCookieOrigin(request);
    const session = await this.auth.verifyLoginOtp(
      input.challengeId,
      input.code,
      clientIp(request),
    );
    return this.setSession(response, session);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Rotate the HttpOnly refresh cookie', description: 'The refresh token is read from the cookie and is never returned in the JSON body.' })
  @ApiOkResponse({ type: RefreshSessionDto })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.assertCookieOrigin(request);
    const refreshToken = cookieValue(request, REFRESH_COOKIE);
    if (!refreshToken) {
      throw new HttpException(
        { code: 'SESSION_EXPIRED', message: 'Session expired' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    const session = await this.auth.refresh(refreshToken);
    this.setSession(response, session);
    return {
      accessToken: session.accessToken,
      accessExpiresAt: session.accessExpiresAt,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Revoke the refresh session' })
  @ApiNoContentResponse()
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    this.assertCookieOrigin(request);
    await this.auth.logout(cookieValue(request, REFRESH_COOKIE));
    response.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }
}

@Controller()
@ApiBearerAuth()
@ApiTags('Authentication')
@ApiResponse({ status: 'default', type: ApiErrorDto })
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get the authenticated user' })
  @ApiOkResponse({ type: PublicUserDto })
  me(@Req() request: AuthenticatedRequest) {
    return this.auth.me(request.user.id);
  }
}
