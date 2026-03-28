import { z } from 'zod';

export const CreateCandidateSchema = z.object({
  // Required fields
  full_name: z.string().min(1, 'Full name is required'),
  source: z.enum(
    ['linkedin', 'website', 'agency', 'referral', 'direct', 'manual'],
    'Source must be one of: linkedin, website, agency, referral, direct, manual',
  ),
  job_id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'job_id must be a valid UUID'),

  // Optional fields
  email: z.email('Must be a valid email').nullable().optional(),
  phone: z.string().nullable().optional(),
  current_role: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  years_experience: z.coerce.number().int().min(0).max(50).nullable().optional(),
  skills: z.preprocess((val) => {
    if (val === undefined || val === null || val === '') return [];

    if (typeof val === 'string') {
      try {
        const parsed = JSON.parse(val);
        return Array.isArray(parsed) ? parsed : [val];
      } catch {
        return [val];
      }
    }

    if (Array.isArray(val)) return val;

    return [];
  }, z.array(z.string())),
  ai_summary: z.string().nullable().optional(),
  source_agency: z.string().nullable().optional(),
});

export type CreateCandidateDto = z.infer<typeof CreateCandidateSchema>;
