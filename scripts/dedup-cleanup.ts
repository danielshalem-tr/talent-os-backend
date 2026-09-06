/**
 * One-off production cleanup for the dedup round (spec §3.2). Order matters:
 *
 *   1. Delete the staff rows named in --delete-ids (confirmed from a dry run).
 *   2. Scrub blocklisted contact values (INTAKE_CONTACT_BLOCKLIST) off every remaining candidate —
 *      the same values intake now refuses to write. Without this the rows that already carry the
 *      office phone would keep matching each other and voice screening would dial the office.
 *   3. Plan phone-match merges over the scrubbed rows with the SAME rules as intake
 *      (digit compare, 7-digit floor, D1 email guard) and fold each pair via mergeCandidates().
 *
 * Dry-run by default — prints the full plan and changes nothing. --apply executes it.
 * Every merge is its own transaction and is logged as one JSON line.
 *
 *   npm run dedup:cleanup                                  # plan only
 *   npm run dedup:cleanup -- --delete-ids=<uuid>,<uuid>    # plan incl. staff deletions
 *   npm run dedup:cleanup -- --delete-ids=<uuid>,<uuid> --apply
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { isBlockedEmail, isBlockedPhone, parseContactBlocklist } from '../src/dedup/contact-blocklist';
import { mergeCandidates, planPhoneMerges } from '../src/dedup/merge-candidates';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function argList(name: string): string[] {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return [];
  return hit
    .slice(name.length + 3)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const tenantId = process.env.TENANT_ID;
  if (!tenantId) throw new Error('TENANT_ID must be set');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must be set');

  const deleteIds = argList('delete-ids');
  for (const id of deleteIds) if (!UUID.test(id)) throw new Error(`--delete-ids contains a non-UUID: ${id}`);

  const blocklist = parseContactBlocklist(process.env.INTAKE_CONTACT_BLOCKLIST);
  if (blocklist.emails.size + blocklist.domains.size + blocklist.phones.size === 0) {
    console.warn(
      'WARNING: INTAKE_CONTACT_BLOCKLIST is empty — nothing will be scrubbed and blocked phones will NOT be excluded from merging.',
    );
  }

  // Prisma 7 here is driver-adapter based (see src/prisma/prisma.service.ts).
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  const flagCount = await prisma.duplicateFlag.count({ where: { tenantId } });
  console.log(`duplicate_flags rows in tenant: ${flagCount} (expected 0 after migration 20260906090000)`);

  // ── 1. Staff deletions ────────────────────────────────────────────────────
  const staff = await prisma.candidate.findMany({
    where: { tenantId, id: { in: deleteIds } },
    select: { id: true, fullName: true, email: true, _count: { select: { applications: true, voiceCalls: true } } },
  });
  const missing = deleteIds.filter((id) => !staff.some((s) => s.id === id));
  if (missing.length > 0) throw new Error(`--delete-ids not found in tenant: ${missing.join(', ')}`);

  console.log(`\n== 1. Delete ${staff.length} candidate(s) by id ==`);
  for (const s of staff)
    console.log(
      `  ${s.id}  ${s.fullName}  ${s.email ?? '-'}  apps=${s._count.applications} calls=${s._count.voiceCalls}`,
    );

  // Suggest deletion candidates: rows whose EMAIL is blocklisted are staff by definition.
  const all = await prisma.candidate.findMany({
    where: { tenantId },
    select: { id: true, fullName: true, email: true, phone: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const staffLike = all.filter((c) => isBlockedEmail(c.email, blocklist) && !deleteIds.includes(c.id));
  if (staffLike.length > 0) {
    console.log(`\n  Rows with a blocklisted EMAIL not in --delete-ids (review — probably staff):`);
    for (const c of staffLike) console.log(`  ${c.id}  ${c.fullName}  ${c.email}`);
  }

  // ── 2. Scrub blocklisted values ───────────────────────────────────────────
  const remaining = all.filter((c) => !deleteIds.includes(c.id));
  const scrubs = remaining
    .map((c) => ({
      id: c.id,
      fullName: c.fullName,
      email: isBlockedEmail(c.email, blocklist) ? c.email : null,
      phone: isBlockedPhone(c.phone, blocklist) ? c.phone : null,
    }))
    .filter((s) => s.email !== null || s.phone !== null);

  console.log(`\n== 2. Scrub blocklisted contact values on ${scrubs.length} candidate(s) ==`);
  for (const s of scrubs)
    console.log(`  ${s.id}  ${s.fullName}  ${s.email ? 'email→null' : ''} ${s.phone ? 'phone→null' : ''}`);

  // ── 3. Phone merges (planned over the post-scrub state) ───────────────────
  const scrubbed = remaining.map((c) => {
    const s = scrubs.find((x) => x.id === c.id);
    return { ...c, email: s?.email ? null : c.email, phone: s?.phone ? null : c.phone };
  });
  const plan = planPhoneMerges(scrubbed, blocklist);
  const nameOf = new Map(all.map((c) => [c.id, `${c.fullName} <${c.email ?? '-'}>`]));

  console.log(`\n== 3. Merge ${plan.merges.length} phone-match pair(s) (older row survives) ==`);
  for (const m of plan.merges)
    console.log(
      `  ${m.digits}  KEEP ${m.survivorId} ${nameOf.get(m.survivorId)}  ←  REMOVE ${m.removedId} ${nameOf.get(m.removedId)}`,
    );
  console.log(`\n   ${plan.shared.length} shared-phone pair(s) left alone (different emails = two people):`);
  for (const s of plan.shared)
    console.log(`  ${s.digits}  ${s.survivorId} ${nameOf.get(s.survivorId)}  |  ${s.otherId} ${nameOf.get(s.otherId)}`);

  if (!apply) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to execute steps 1–3 in this order.');
    await prisma.$disconnect();
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  if (flagCount > 0) {
    const purged = await prisma.duplicateFlag.deleteMany({ where: { tenantId } });
    console.log(`\nPurged ${purged.count} duplicate_flags row(s) (RESTRICT FKs would block the deletes below).`);
  }

  for (const s of staff) {
    await prisma.$transaction(async (tx) => {
      await tx.duplicateFlag.deleteMany({ where: { OR: [{ candidateId: s.id }, { matchedCandidateId: s.id }] } });
      await tx.emailIntakeLog.updateMany({ where: { candidateId: s.id }, data: { candidateId: null } });
      await tx.candidate.delete({ where: { id: s.id } }); // applications, scores, voice calls, summaries cascade
    });
    console.log(JSON.stringify({ step: 'delete', id: s.id }));
  }

  for (const s of scrubs) {
    await prisma.candidate.update({
      where: { id: s.id },
      data: { ...(s.email ? { email: null } : {}), ...(s.phone ? { phone: null } : {}) },
    });
    console.log(
      JSON.stringify({ step: 'scrub', id: s.id, fields: [s.email && 'email', s.phone && 'phone'].filter(Boolean) }),
    );
  }

  for (const m of plan.merges) {
    const log = await prisma.$transaction(
      (tx) => mergeCandidates(tx, { tenantId, survivorId: m.survivorId, removedId: m.removedId }),
      { timeout: 30_000 },
    );
    console.log(JSON.stringify({ step: 'merge', ...log }));
  }

  console.log(`\nDone: deleted ${staff.length}, scrubbed ${scrubs.length}, merged ${plan.merges.length}.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
