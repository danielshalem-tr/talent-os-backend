import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  // ANTHROPIC_API_KEY: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  MAILGUN_WEBHOOK_SIGNING_KEY: z.string().min(1),
  TENANT_ID: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID')
    .optional(),
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
  // Comma-separated email domains allowed to sign in via Google (e.g. "triolla.io").
  // Unset = open self-signup with per-signup org creation (original multi-tenant behavior).
  // Set  = other domains are rejected, and new users join the TENANT_ID org as 'member'.
  AUTH_ALLOWED_DOMAINS: z.string().optional(),
  EXTRACTION_MODEL: z.string().default('openai/gpt-4o-mini'),
  // The CV scoring model is hard-coded in src/scoring/scoring.service.ts (chosen by bake-off,
  // policy tuned to it). The post-call voice assessor keeps its own key.
  VOICE_ASSESSMENT_MODEL: z.string().default('openai/gpt-4o-mini'),
  CLASSIFIER_MODEL: z.string().default('openai/gpt-4o-mini'),
  // Comma-separated "wrongNumber:realShortId" pairs applied to job numbers parsed out of
  // intake emails — e.g. "300:106" when a live ad quotes a number no job has.
  SHORT_ID_ALIASES: z.string().default(''),
  // Fallback role matcher — runs only for intakes with no job number in the email.
  MATCHER_MODEL: z.string().default('openai/gpt-4o-mini'),
  // Intake contact blocklist (spec D3): comma-separated emails, `@domain` entries and phone
  // numbers belonging to tenant staff / agencies. Matching extracted values are nulled before
  // dedup and before insert, so they can never be attributed to a candidate or create a match.
  INTAKE_CONTACT_BLOCKLIST: z.string().default(''),
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
  // one-time ElevenLabs setup (internal runbook, kept outside this repo), and the gateway fails
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

// Domain-restricted Google login attaches new users to the TENANT_ID org, so the pair must be
// configured together. Enforced at boot on the processes that run googleVerify (API + MCP) —
// a request-time failure here would mean every new-user login 500s while the app looks healthy.
const requireTenantWithAllowedDomains = (
  env: { AUTH_ALLOWED_DOMAINS?: string; TENANT_ID?: string },
  ctx: z.RefinementCtx,
) => {
  if ((env.AUTH_ALLOWED_DOMAINS ?? '').trim().length > 0 && !env.TENANT_ID) {
    ctx.addIssue({
      code: 'custom',
      path: ['TENANT_ID'],
      message: 'AUTH_ALLOWED_DOMAINS is set but TENANT_ID is not — new allowed users have no org to join',
    });
  }
};

// API-process schema. Since the 2026-09 PM Bridge cutover the API has no Jira dependency;
// the only API-specific rule left is the AUTH_ALLOWED_DOMAINS / TENANT_ID pairing.
export const apiEnvSchema = envSchema.superRefine(requireTenantWithAllowedDomains);

export type ApiEnv = z.infer<typeof apiEnvSchema>;

// MCP-process schema — MCP public URL and its dedicated signing secret are required
// (the MCP token secret is intentionally distinct from JWT_SECRET so MCP tokens can
// never be replayed against the SPA's SessionGuard).
export const mcpEnvSchema = envSchema
  .extend({
    MCP_PUBLIC_URL: z.url(),
    MCP_JWT_SECRET: z.string().min(32, 'MCP_JWT_SECRET must be at least 32 characters'),
    GOOGLE_CLIENT_ID: z.string().min(1),
  })
  .superRefine(requireTenantWithAllowedDomains);

export type McpEnv = z.infer<typeof mcpEnvSchema>;
