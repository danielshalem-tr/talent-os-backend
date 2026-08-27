import { z } from 'zod';

export const TriggerCallSchema = z.object({
  job_id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID'),
});

export type TriggerCallDto = z.infer<typeof TriggerCallSchema>;
