import { NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../models/user.types.js';

/** Hide the existence of another customer's resource. */
export function assertOwnerOrAdmin(actor: AuthUser, ownerUserId: string): void {
  if (actor.role !== 'admin' && actor.id !== ownerUserId) {
    throw new NotFoundException({ code: 'NOT_FOUND', message: 'Resource not found' });
  }
}
