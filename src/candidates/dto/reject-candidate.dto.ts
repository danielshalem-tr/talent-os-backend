import { z } from 'zod';

export const REJECTION_REASONS = [
  'not_a_fit',
  'overqualified',
  'underqualified',
  'failed_screening',
  'compensation_mismatch',
  'culture_fit',
  'other',
] as const;

export const RejectCandidateSchema = z.object({
  reason: z.enum(REJECTION_REASONS),
  note: z.string().max(500).optional(),
});

export type RejectCandidateDto = z.infer<typeof RejectCandidateSchema>;
