import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { safeErrorKind } from '../utils/safe-error.js';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class AuthMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthMaintenanceService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly auth: AuthService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.runOnce(); }, CLEANUP_INTERVAL_MS);
    this.timer.unref();
    void this.runOnce();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.auth.cleanupExpiredAuthData(500);
      if (result.clearedOtpPayloads || result.deletedChallenges || result.deletedRateCounters) {
        this.logger.log(`Auth cleanup: ${JSON.stringify(result)}`);
      }
    } catch (error) {
      this.logger.error(`Auth cleanup failed; next pass will retry: ${safeErrorKind(error)}`);
    } finally {
      this.running = false;
    }
  }
}
