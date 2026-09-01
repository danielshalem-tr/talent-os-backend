import { z } from 'zod';

// Same UUID shape the other candidate DTOs use (see update-candidate.dto.ts).
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID');

/**
 * Cap at 200: each id costs one scoring call, so an unbounded list is an unbounded
 * AI bill. The talent-pool selection accumulates across pages, so this IS reachable
 * from the UI — the dialog mirrors the limit (MAX_BULK_ASSIGN) and blocks before
 * sending, since a 400 here surfaces only as a generic "try again".
 */
export const BulkAssignSchema = z.object({
  candidate_ids: z
    .array(uuid)
    .min(1, 'At least one candidate is required')
    .max(200, 'At most 200 candidates per request'),
  job_id: uuid,
});

export type BulkAssignDto = z.infer<typeof BulkAssignSchema>;
