import { z } from 'zod';

export const ReopenRequestSchema = z.object({
  comment: z.string().trim().min(3, 'Please say what is missing (at least 3 characters)'),
});

export type ReopenRequest = z.infer<typeof ReopenRequestSchema>;

/** Jira issue key, e.g. TO-123. Rejects lowercase, underscores, and bare numbers. */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
