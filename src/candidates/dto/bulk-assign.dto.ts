import { z } from 'zod';

// Same UUID shape the other candidate DTOs use (see update-candidate.dto.ts).
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID');

/**
 * Cap at 200: each id costs one scoring call, so an unbounded list is an unbounded
 * AI bill. The talent-pool UI selects at most one page at a time, well under this.
 */
export const BulkAssignSchema = z.object({
  candidate_ids: z
    .array(uuid)
    .min(1, 'At least one candidate is required')
    .max(200, 'At most 200 candidates per request'),
  job_id: uuid,
});

export type BulkAssignDto = z.infer<typeof BulkAssignSchema>;
