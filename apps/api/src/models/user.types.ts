export type UserRole = 'customer' | 'admin';

export interface AuthUser {
  id: string;
  role: UserRole;
  sessionId: string;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
}
