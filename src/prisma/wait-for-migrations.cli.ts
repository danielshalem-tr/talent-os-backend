/**
 * Entry point for the worker's boot gate — see wait-for-migrations.ts for why it exists.
 *
 * Deliberately thin: every decision lives in the tested module, so there is nothing here
 * to unit-test beyond wiring. Exits 0 once the schema is ready, 1 on timeout so the
 * container dies and the orchestrator restarts it rather than consuming jobs blindly.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { latestMigrationName, waitForMigration } from './wait-for-migrations';

const MIGRATIONS_DIR = process.env.PRISMA_MIGRATIONS_DIR ?? join(process.cwd(), 'prisma', 'migrations');
const TIMEOUT_MS = Number(process.env.MIGRATION_WAIT_TIMEOUT_MS ?? 120_000);
const INTERVAL_MS = Number(process.env.MIGRATION_WAIT_INTERVAL_MS ?? 1_000);

/**
 * A fresh connection per attempt, on purpose: while Postgres is still starting, connecting
 * throws — which waitForMigration treats as not-ready. A single long-lived client would
 * instead have to be reconnected by hand.
 */
async function isApplied(migrationName: string): Promise<boolean> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(
      'SELECT 1 FROM _prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL LIMIT 1',
      [migrationName],
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    await client.end();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const expected = latestMigrationName(readdirSync(MIGRATIONS_DIR));
  console.log(`[wait-for-migrations] waiting for ${expected} (timeout ${TIMEOUT_MS}ms)`);

  await waitForMigration({
    expected,
    isApplied,
    timeoutMs: TIMEOUT_MS,
    intervalMs: INTERVAL_MS,
    log: (message) => console.log(`[wait-for-migrations] ${message}`),
  });

  console.log(`[wait-for-migrations] ${expected} is applied — starting`);
}

main().catch((err: Error) => {
  console.error(`[wait-for-migrations] ${err.message}`);
  process.exit(1);
});
