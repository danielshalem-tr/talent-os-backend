import { z } from 'zod';

export const CreateCandidateSchema = z.object({
  // Required fields
  full_name: z.string().min(1, 'Full name is required'),
  source: z.enum(['linkedin', 'website', 'agency', 'referral', 'direct'], 'Source must be one of: linkedin, website, agency, referral, direct'),
  job_id: z.string().uuid('job_id must be a valid UUID'),

  // Optional fields
  email: z.string().email('Must be a valid email').nullable().optional(),
  phone: z.string().nullable().optional(),
  current_role: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  years_experience: z.number().int().min(0).max(50).nullable().optional(),
  skills: z.array(z.string()).default([]),
  ai_summary: z.string().nullable().optional(),
  source_agency: z.string().nullable().optional(),
});

export type CreateCandidateDto = z.infer<typeof CreateCandidateSchema>;
