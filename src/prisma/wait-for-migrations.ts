/**
 * Boot gate for containers that read the DB but do not run migrations.
 *
 * Only the API runs `prisma migrate deploy` (see `Dockerfile` CMD). On a deploy carrying a
 * migration, the worker would otherwise start consuming jobs against the un-migrated schema:
 * each job fails on the missing column, burns its 3 BullMQ attempts, and strands the intake
 * row in 'pending' with no error surfaced anywhere. The queue's 5s exponential backoff gives
 * roughly a 15s window, which a fast migration usually wins — "usually" being the problem.
 *
 * This gate makes it deterministic: the worker refuses to consume until the exact migration
 * its own image was built with is recorded as finished.
 */

// Prisma names migration directories `<14-digit timestamp>_<slug>`. Anything else in
// prisma/migrations (notably migration_lock.toml) is not a migration.
const MIGRATION_DIR = /^\d{14}_/;

export function latestMigrationName(entries: string[]): string {
  const migrations = entries.filter((entry) => MIGRATION_DIR.test(entry)).sort();
  if (migrations.length === 0) {
    throw new Error('Found no migrations in prisma/migrations — is the directory present in the image?');
  }
  return migrations[migrations.length - 1];
}

export interface WaitForMigrationOptions {
  /** Migration this build expects — normally `latestMigrationName(readdirSync(...))`. */
  expected: string;
  /** Resolves true once `expected` is recorded as finished. May reject; that counts as not-ready. */
  isApplied: (name: string) => Promise<boolean>;
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export async function waitForMigration(opts: WaitForMigrationOptions): Promise<void> {
  const { expected, isApplied, timeoutMs, intervalMs } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const deadline = now() + timeoutMs;

  for (let attempt = 1; ; attempt++) {
    let applied = false;
    try {
      applied = await isApplied(expected);
    } catch {
      // Postgres still refusing connections, or _prisma_migrations not created yet on a
      // first-ever deploy. Both mean "not ready", not "broken".
      applied = false;
    }

    if (applied) return;

    if (now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for migration ${expected} to be applied`);
    }

    log(`Migration ${expected} not applied yet (attempt ${attempt}) — retrying in ${intervalMs}ms`);
    await sleep(intervalMs);
  }
}
