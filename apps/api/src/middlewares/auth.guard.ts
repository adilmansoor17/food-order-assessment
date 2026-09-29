import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { AuthUser } from '../models/user.types.js';
import { AuthService } from '../services/auth.service.js';
import type { AccessClaims } from '../models/auth.types.js';

export type AuthenticatedRequest = Request & { user: AuthUser };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const match = /^Bearer (\S+)$/i.exec(authorization ?? '');
    if (!match) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }
    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(match[1], {
        secret: this.auth.accessTokenSecret(),
        issuer: this.auth.jwtIssuer(),
        audience: this.auth.jwtAudience(),
      });
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }
    if (claims.typ !== 'access' || !claims.sub || !claims.sid) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }
    const user = await this.auth.activeUserForAccess(claims.sid, claims.sub);
    if (!user) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }
    request.user = { id: user.id, role: user.role, sessionId: claims.sid };
    return true;
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.user?.role !== 'admin') {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Forbidden' });
    }
    return true;
  }
}
