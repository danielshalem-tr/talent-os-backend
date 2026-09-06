import { Prisma } from '@prisma/client';

/**
 * The single phone-match query. Both sides are compared as digit strings: the caller passes
 * `phoneDigits(...)` output, the SQL strips the stored value the same way. Oldest row wins so
 * repeated submissions always converge on the first record. Selecting `email` lets the caller
 * apply the D1 email-compatibility guard without a second round-trip.
 *
 * A plain function (not a provider) so CandidatesService (POST /candidates) and DedupService
 * share it without module rewiring — the stage-move.ts pattern.
 */
export async function findCandidateByPhoneDigits(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  tenantId: string,
  digits: string,
): Promise<{ id: string; email: string | null } | null> {
  const rows = await client.$queryRaw<{ id: string; email: string | null }[]>`
    SELECT id::text, email
    FROM candidates
    WHERE tenant_id = ${tenantId}::uuid
      AND phone IS NOT NULL
      AND regexp_replace(phone, '[^0-9]', '', 'g') = ${digits}
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}
