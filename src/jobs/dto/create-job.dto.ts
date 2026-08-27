import { z } from 'zod';

export const HiringStageCreateSchema = z.object({
  id: z.string().optional(), // Temp client UUID
  name: z.string().min(1, 'Stage name required').max(255),
  order: z.number().int().min(1),
  interviewer: z.string().nullable().optional(),
  color: z.string().min(1),
  is_enabled: z.boolean().default(true),
  is_custom: z.boolean().default(false),
});
export type HiringStageCreateInput = z.infer<typeof HiringStageCreateSchema>;

export const ScreeningQuestionCreateSchema = z.object({
  id: z.string().optional(), // Temp client UUID
  text: z.string().min(1, 'Question text required'),
  type: z.enum(['yes_no', 'text']),
  expected_answer: z.string().nullable().optional(),
  order: z.number().int().min(1).optional(),
});
export type ScreeningQuestionCreateInput = z.infer<typeof ScreeningQuestionCreateSchema>;

export const CreateJobSchema = z
  .object({
    // Required
    title: z.string().min(1, 'Job title required').max(255),
    // Optional job fields
    department: z.string().optional(),
    location: z.string().optional().default("Ra'anana"),
    job_type: z.enum(['full_time', 'part_time', 'contract']).default('full_time'),
    status: z.enum(['draft', 'open', 'closed']).default('draft'),
    hiring_manager: z.string().optional(),
    description: z.string().optional(),
    responsibilities: z.string().optional(),
    what_we_offer: z.string().optional(),
    salary_range: z.string().optional(),
    must_have_skills: z.array(z.string()).default([]),
    nice_to_have_skills: z.array(z.string()).default([]),
    min_experience: z.number().int().min(0).optional(),
    max_experience: z.number().int().min(0).optional(),
    selected_org_types: z.array(z.string()).default([]),
    // Voice screening: OPTIONAL WITHOUT DEFAULTS — updateJob is full-replace, and a Zod
    // default here would silently reset the toggle for any client not sending the field.
    voice_screening_enabled: z.boolean().optional(),
    voice_min_score: z.number().int().min(0).max(100).optional(),
    // Nested arrays
    screening_questions: z.array(ScreeningQuestionCreateSchema).optional(),
    hiring_flow: z.array(HiringStageCreateSchema).optional(),
  })
  .refine(
    (data) => {
      // If hiring_flow provided and non-empty, at least one stage must be enabled
      if (data.hiring_flow && data.hiring_flow.length > 0) {
        return data.hiring_flow.some((s) => s.is_enabled);
      }
      // If hiring_flow not provided (or empty), defaults will be seeded — no refine needed
      return true;
    },
    {
      message: 'At least one hiring stage must be enabled',
      path: ['hiring_flow'],
    },
  );

export type CreateJobDto = z.input<typeof CreateJobSchema>;
