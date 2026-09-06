import { Prisma } from '@prisma/client';

/**
 * Every candidate sharing a phone (digit-compare on both sides; the caller passes
 * `phoneDigits(...)` output). Oldest first, so repeated submissions converge on the first
 * record. Selecting `email` lets DedupService apply the D1 compatibility guard to EACH row —
 * the oldest row alone used to decide, hiding a later compatible row behind an incompatible one.
 * The expression matches idx_candidates_phone_digits (migration 20260907000000) exactly.
 *
 * A plain function (not a provider) so CandidatesService (POST /candidates) and DedupService
 * share it without module rewiring — the stage-move.ts pattern.
 */
export async function findCandidatesByPhoneDigits(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  tenantId: string,
  digits: string,
  limit = 10,
): Promise<{ id: string; email: string | null }[]> {
  return client.$queryRaw<{ id: string; email: string | null }[]>`
    SELECT id::text, email
    FROM candidates
    WHERE tenant_id = ${tenantId}::uuid
      AND phone IS NOT NULL
      AND regexp_replace(phone, '[^0-9]', '', 'g') = ${digits}
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}

/** Single-row form for POST /candidates (CandidatesService.createCandidate). */
export async function findCandidateByPhoneDigits(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  tenantId: string,
  digits: string,
): Promise<{ id: string; email: string | null } | null> {
  const rows = await findCandidatesByPhoneDigits(client, tenantId, digits, 1);
  return rows[0] ?? null;
}
