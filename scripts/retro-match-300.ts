/**
 * One-off retro: job #106 was advertised as "#300", so every applicant since the ad went
 * live landed unassigned and unscored. This finds those intakes, and enqueues the SAME
 * assign+score job the live bulk-assign path uses — no duplicated logic.
 *
 * Dry-run by default. There is no test environment: it must print what it would do and
 * change nothing until you pass --apply.
 *
 *   npm run retro:match -- --since=2026-08-31 --alias=300:106
 *   npm run retro:match -- --since=2026-08-31 --alias=300:106 --apply
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Queue } from 'bullmq';
import { extractShortIds } from '../src/ingestion/extract-short-ids';
import { parseShortIdAliases, applyShortIdAliases } from '../src/config/short-id-aliases';
import { ASSIGN_JOB_OPTS, AssignJobData, BULK_ASSIGN_QUEUE } from '../src/bulk-assign/bulk-assign.types';

function arg(name: string, fallback?: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument --${name}=`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const since = new Date(`${arg('since', '2026-08-31')}T00:00:00Z`);
  const aliases = parseShortIdAliases(arg('alias', '300:106'));
  const tenantId = process.env.TENANT_ID;
  if (!tenantId) throw new Error('TENANT_ID must be set');
  if (aliases.size === 0) throw new Error('--alias must contain at least one from:to pair');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must be set');

  // Prisma 7 in this repo is driver-adapter based (see src/prisma/prisma.service.ts and
  // prisma/seed.ts) — a bare `new PrismaClient()` throws at construction.
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  // Resolve every alias target short_id to a real open job.
  const targets = new Map<string, string>(); // aliased short_id -> job uuid
  for (const [from, to] of aliases) {
    const job = await prisma.job.findFirst({ where: { tenantId, shortId: to }, select: { id: true, status: true } });
    if (!job) throw new Error(`No job with short_id=${to} in tenant ${tenantId}`);
    if (job.status !== 'open') throw new Error(`Job short_id=${to} is ${job.status}, not open`);
    targets.set(from, job.id);
  }

  const intakes = await prisma.emailIntakeLog.findMany({
    where: { tenantId, receivedAt: { gte: since }, candidateId: { not: null } },
    select: { id: true, messageId: true, subject: true, rawPayload: true, rawPayloadKey: true, candidateId: true },
  });

  const hits = new Map<string, string>(); // candidateId -> target job uuid
  let noPayload = 0;

  for (const intake of intakes) {
    const payload = intake.rawPayload as { TextBody?: string } | null;
    if (payload === null && intake.subject === null) {
      // rawPayload was offloaded to R2 (rawPayloadKey) — we cannot read the body here.
      noPayload += 1;
      continue;
    }
    const parsed = extractShortIds(intake.subject, payload?.TextBody ?? null);
    if (parsed.length === 0) continue;
    const rewritten = applyShortIdAliases(parsed, aliases);
    // Only count intakes that matched an ALIASED number — an email that already carried
    // the right job number was handled correctly at the time.
    const matchedAlias = parsed.find((id) => aliases.has(id));
    if (!matchedAlias || !rewritten.includes(aliases.get(matchedAlias)!)) continue;
    hits.set(intake.candidateId!, targets.get(matchedAlias)!);
  }

  // Only candidates still unassigned and still active.
  const candidates = await prisma.candidate.findMany({
    where: { tenantId, id: { in: [...hits.keys()] }, jobId: null, status: 'active' },
    select: { id: true },
  });

  console.log(`Intakes scanned since ${since.toISOString()}: ${intakes.length}`);
  console.log(`Intakes whose body could not be read (payload offloaded to R2): ${noPayload}`);
  console.log(`Intakes quoting an aliased job number: ${hits.size}`);
  console.log(`Of those, candidates still unassigned + active: ${candidates.length}`);

  if (!apply) {
    console.log('\nDRY RUN — nothing was queued. Re-run with --apply to enqueue.');
    await prisma.$disconnect();
    return;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL must be set to enqueue');
  const queue = new Queue(BULK_ASSIGN_QUEUE, { connection: { url: redisUrl } });

  for (const candidate of candidates) {
    const jobId = hits.get(candidate.id)!;
    await queue.add(
      'assign',
      { tenantId, candidateId: candidate.id, jobId } satisfies AssignJobData,
      { jobId: `assign-${candidate.id}-${jobId}`, ...ASSIGN_JOB_OPTS },
    );
  }

  console.log(`\nQueued ${candidates.length} assign+score jobs on "${BULK_ASSIGN_QUEUE}".`);
  await queue.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
