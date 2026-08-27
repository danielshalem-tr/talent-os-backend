import { z } from 'zod';

// Deliberately loose: ElevenLabs payloads are large and evolve; we validate only what we
// dispatch on and read defensively from the rest (raw→internal split like mailgun-payload.dto.ts,
// but the "internal" mapping happens in voice-results.service.ts).
export const ElevenLabsWebhookSchema = z.object({
  type: z.string(),
  event_timestamp: z.number().optional(),
  data: z.looseObject({ conversation_id: z.string() }).optional(),
});

export type ElevenLabsWebhookEvent = z.infer<typeof ElevenLabsWebhookSchema>;
