import type { AuthService } from './auth.service.js';
import { AuthMaintenanceService } from './auth-maintenance.service.js';

describe('AuthMaintenanceService', () => {
  it('does not overlap cleanup passes within a worker process', async () => {
    let finish!: () => void;
    const firstPass = new Promise<void>((resolve) => { finish = resolve; });
    const cleanup = vi.fn()
      .mockImplementationOnce(async () => {
        await firstPass;
        return { clearedOtpPayloads: 0, deletedChallenges: 0, deletedRateCounters: 0 };
      })
      .mockResolvedValue({ clearedOtpPayloads: 0, deletedChallenges: 0, deletedRateCounters: 0 });
    const maintenance = new AuthMaintenanceService({ cleanupExpiredAuthData: cleanup } as unknown as AuthService);

    const running = maintenance.runOnce();
    await maintenance.runOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    finish();
    await running;
    await maintenance.runOnce();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledWith(500);
  });
});
