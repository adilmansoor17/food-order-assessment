import type { PublicUser } from './user.types.js';

export interface UserRow {
  id: string;
  name: string;
  email: string;
  phone_e164: string;
  password_hash: string;
  role: 'customer' | 'admin';
  status: 'active' | 'disabled';
  created_at: Date;
}

export type OtpChannel = 'email' | 'phone';
export type OtpPurpose = 'login';

export interface AuthSessionResult {
  user: PublicUser;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
}

export interface AccessClaims {
  sub: string;
  sid: string;
  typ: 'access';
  iss: string;
  aud: string;
  exp: number;
}

export interface RefreshClaims {
  sub: string;
  sid: string;
  fid: string;
  typ: 'refresh';
  iss: string;
  aud: string;
  exp: number;
}

export function publicUser(row: Pick<UserRow, 'id' | 'name' | 'email' | 'phone_e164' | 'role'>): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone_e164,
    role: row.role,
  };
}
