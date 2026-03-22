import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  ANTHROPIC_API_KEY: z.string().min(1),
  POSTMARK_WEBHOOK_TOKEN: z.string().min(1),
  TENANT_ID: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID'),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
});

export type Env = z.infer<typeof envSchema>;
