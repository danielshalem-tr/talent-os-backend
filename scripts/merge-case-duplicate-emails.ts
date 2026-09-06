/**
 * One-off: fold candidates whose emails differ only by letter case into one row, so the
 * case-insensitive unique index (migration 20260907000000) can be created. Survivor = oldest
 * row; every other row is merged via the SAME mergeCandidates() the dedup cleanup used
 * (applications, scores, intake logs, voice calls, stage summaries all re-pointed).
 *
 * Dry-run by default — prints the plan and changes nothing. --apply executes, one transaction
 * per merge, one JSON log line each.
 *
 *   npm run dedup:merge-case-emails              # plan only
 *   npm run dedup:merge-case-emails -- --apply
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { mergeCandidates } from '../src/dedup/merge-candidates';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const tenantId = process.env.TENANT_ID;
  if (!tenantId) throw new Error('TENANT_ID must be set');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must be set');

  // Prisma 7 here is driver-adapter based (see src/prisma/prisma.service.ts).
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  const groups = await prisma.$queryRaw<{ key: string; ids: string[] }[]>`
    SELECT lower(email) AS key, array_agg(id::text ORDER BY created_at ASC) AS ids
    FROM candidates
    WHERE tenant_id = ${tenantId}::uuid AND email IS NOT NULL
    GROUP BY lower(email)
    HAVING count(*) > 1
  `;
  console.log(`${groups.length} case-duplicate email group(s) — ${apply ? 'APPLYING' : 'dry run'}`);

  let merged = 0;
  for (const group of groups) {
    const [survivorId, ...removed] = group.ids;
    for (const removedId of removed) {
      console.log(JSON.stringify({ email: group.key, survivorId, removedId }));
      if (!apply) continue;
      const log = await prisma.$transaction((tx) => mergeCandidates(tx, { tenantId, survivorId, removedId }), {
        timeout: 30_000,
      });
      console.log(JSON.stringify(log));
      merged += 1;
    }
  }
  console.log(apply ? `merged ${merged} row(s)` : 'dry run — re-run with --apply to execute');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
