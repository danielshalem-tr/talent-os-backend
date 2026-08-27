import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  // ANTHROPIC_API_KEY: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  MAILGUN_WEBHOOK_SIGNING_KEY: z.string().min(1),
  TENANT_ID: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID').optional(),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  // Auth email via nodemailer SMTP (provider-agnostic — use Resend via smtp.resend.com)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  FRONTEND_URL: z.url().default('http://localhost:5173'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  EXTRACTION_MODEL: z.string().default('openai/gpt-4o-mini'),
  SCORING_MODEL: z.string().default('openai/gpt-4o-mini'),
  CLASSIFIER_MODEL: z.string().default('openai/gpt-4o-mini'),
  // PM Bridge — Jira integration.
  // Optional in this shared/base schema so the BullMQ worker (which never calls Jira) can boot
  // without these. The API process re-requires JIRA_BASE_URL/EMAIL/API_TOKEN via apiEnvSchema.
  JIRA_BASE_URL: z.url().optional(),
  JIRA_EMAIL: z.string().min(1).optional(),
  JIRA_API_TOKEN: z.string().min(1).optional(),
  JIRA_PROJECT_KEY: z.string().default('TO'),
  // Board whose *active* sprint new PM Bridge issues are added to (resolved live each filing).
  JIRA_BOARD_ID: z.coerce.number().int().positive().optional(),
  // Optional override: pin issues to a fixed sprint id instead of the board's active sprint.
  JIRA_SPRINT_ID: z.coerce.number().int().positive().optional(),
  PM_BRIDGE_ALLOWLIST: z.string().default(''),
  PM_BRIDGE_MODEL: z.string().default('anthropic/claude-sonnet-4.6'),
  // PM Bridge smart-intake. Optional in the base schema (worker never uses them);
  // the API re-requires the secret + assignee via apiEnvSchema.
  JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID: z.string().min(1).optional(),
  JIRA_DEFAULT_ASSIGNEE_EMAIL: z.string().min(1).optional(),
  PM_HOLD_NOTIFY_EMAIL: z.string().min(1).default('daniel.s@triolla.io'),
  PM_HOLD_TOKEN_SECRET: z.string().min(32, 'PM_HOLD_TOKEN_SECRET must be at least 32 characters').optional(),
  API_PUBLIC_URL: z.url().optional(),
  MCP_PUBLIC_URL: z.url().optional(),
  MCP_JWT_SECRET: z.string().min(32, 'MCP_JWT_SECRET must be at least 32 characters').optional(),
  // Optional extra Host header values allowed at /mcp (DNS-rebinding allowlist) when a reverse
  // proxy forwards a Host that differs from MCP_PUBLIC_URL's host. Comma-separated.
  MCP_ALLOWED_HOSTS: z.string().optional(),
  // PM Bridge standalone plugin ("the Box") — host-app credentials used by the
  // /pmb-token mint route. Optional: the route returns 503 NOT_CONFIGURED until both
  // are set, and neither the API nor the worker requires them to boot.
  PMB_API_KEY: z.string().min(1).optional(),
  PMB_SIGNING_SECRET: z.string().min(32, 'PMB_SIGNING_SECRET must be at least 32 characters').optional(),

  // Voice screening (ElevenLabs). All optional in every schema: deploys ship before the
  // one-time ElevenLabs setup (docs/voice-screening-setup.md), and the gateway fails
  // closed ('not_configured') until the three ELEVENLABS_* core vars are set.
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  ELEVENLABS_AGENT_ID: z.string().min(1).optional(),
  ELEVENLABS_AGENT_PHONE_NUMBER_ID: z.string().min(1).optional(),
  // API-only in practice (webhook HMAC) but kept optional here — the guard 401s when unset.
  ELEVENLABS_WEBHOOK_SECRET: z.string().min(1).optional(),
  // How the agent's number lives in ElevenLabs: 'twilio' for numbers bought there / imported
  // from Twilio, 'sip' for SIP-trunk imports (Telnyx etc.). Mirrors the Scheduler's switch;
  // its production number is a SIP-trunk import, hence the default.
  ELEVENLABS_TELEPHONY: z.enum(['twilio', 'sip']).default('sip'),
  // Safety layer 2: anything other than the literal 'live' enforces the allowlist.
  VOICE_CALL_MODE: z.enum(['test', 'live']).default('test'),
  // Safety layer 1: comma-separated phone numbers callable in test mode. Empty ⇒ block ALL.
  VOICE_CALL_ALLOWLIST: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

// API-process schema. PM Bridge runs only in the API, so Jira credentials are required there:
// the API fails fast at startup if they're missing. The worker validates against the base
// envSchema above and therefore boots without any Jira configuration.
export const apiEnvSchema = envSchema.extend({
  JIRA_BASE_URL: z.url(),
  JIRA_EMAIL: z.string().min(1),
  JIRA_API_TOKEN: z.string().min(1),
  JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID: z.string().min(1),
  PM_HOLD_TOKEN_SECRET: z.string().min(32, 'PM_HOLD_TOKEN_SECRET must be at least 32 characters'),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

// MCP-process schema — MCP public URL and its dedicated signing secret are required
// (the MCP token secret is intentionally distinct from JWT_SECRET so MCP tokens can
// never be replayed against the SPA's SessionGuard).
export const mcpEnvSchema = envSchema.extend({
  MCP_PUBLIC_URL: z.url(),
  MCP_JWT_SECRET: z.string().min(32, 'MCP_JWT_SECRET must be at least 32 characters'),
  GOOGLE_CLIENT_ID: z.string().min(1),
});

export type McpEnv = z.infer<typeof mcpEnvSchema>;
