import { latestMigrationName, waitForMigration } from './wait-for-migrations';

describe('latestMigrationName', () => {
  it('picks the lexicographically last migration directory', () => {
    const entries = [
      '20260701040310_add_is_score_overridden',
      '20260811000000_add_ai_ingest_enabled',
      '20260705000000_add_pm_ticket_reviews',
    ];
    expect(latestMigrationName(entries)).toBe('20260811000000_add_ai_ingest_enabled');
  });

  it('ignores migration_lock.toml', () => {
    const entries = ['20260701040310_add_is_score_overridden', 'migration_lock.toml'];
    expect(latestMigrationName(entries)).toBe('20260701040310_add_is_score_overridden');
  });

  it('throws when no migration directories are present', () => {
    expect(() => latestMigrationName(['migration_lock.toml'])).toThrow(/no migrations/i);
  });
});

describe('waitForMigration', () => {
  // A fake clock: `now` only advances when `sleep` is called, so the timeout is
  // driven by poll count rather than real elapsed time and the test stays instant.
  function fakeClock() {
    let t = 0;
    return {
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    };
  }

  const base = { expected: 'm2', timeoutMs: 10_000, intervalMs: 1_000 };

  it('resolves without sleeping when the migration is already applied', async () => {
    const clock = fakeClock();
    const isApplied = jest.fn().mockResolvedValue(true);

    await waitForMigration({ ...base, isApplied, ...clock });

    expect(isApplied).toHaveBeenCalledTimes(1);
    expect(clock.now()).toBe(0);
  });

  it('polls until the migration shows up', async () => {
    const clock = fakeClock();
    const isApplied = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);

    await waitForMigration({ ...base, isApplied, ...clock });

    expect(isApplied).toHaveBeenCalledTimes(3);
    expect(clock.now()).toBe(2_000);
  });

  it('keeps polling when the check throws — a missing _prisma_migrations table means not-ready, not fatal', async () => {
    const clock = fakeClock();
    const isApplied = jest
      .fn()
      .mockRejectedValueOnce(new Error('relation "_prisma_migrations" does not exist'))
      .mockResolvedValue(true);

    await waitForMigration({ ...base, isApplied, ...clock });

    expect(isApplied).toHaveBeenCalledTimes(2);
  });

  it('throws once the timeout elapses, naming the migration it waited for', async () => {
    const clock = fakeClock();
    const isApplied = jest.fn().mockResolvedValue(false);

    await expect(waitForMigration({ ...base, isApplied, ...clock })).rejects.toThrow(/m2/);
    expect(clock.now()).toBeGreaterThanOrEqual(base.timeoutMs);
  });

  it('reports each attempt so a stuck worker is visible in the deploy logs', async () => {
    const clock = fakeClock();
    const log = jest.fn();
    const isApplied = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);

    await waitForMigration({ ...base, isApplied, log, ...clock });

    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toContain('m2');
  });
});
