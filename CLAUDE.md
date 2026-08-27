# Triolla Talent OS — Backend

Automated email-intake pipeline for Triolla's recruiting platform: CVs arrive by email via
**Mailgun** inbound webhooks → AI extracts candidate data → dedup → scored against open jobs →
stored in PostgreSQL for the recruiter UI. The intake pipeline is fully reactive (no human
trigger), but the platform now also has organizations, users, session auth (Google OAuth +
magic link), invitations, team management, and role-based access (admin / recruiter / viewer).

## Stack (locked, not negotiable)

- **Runtime/Framework:** Node.js 22, TypeScript 5, NestJS 11 — two entry points:
  `src/main.ts` (API) and `src/worker.ts` (BullMQ worker)
- **Queue:** BullMQ + Redis 7
- **ORM/DB:** Prisma 7 with `@prisma/adapter-pg` → PostgreSQL 16
- **AI:** OpenRouter (`@openrouter/sdk`), model `openai/gpt-4o-mini` (extraction + scoring)
- **Storage:** Cloudflare R2 (`@aws-sdk/client-s3`) for original CV files
- **Email:** Mailgun inbound webhook → `POST /webhooks/email`
- **Dedup:** pg_trgm in PostgreSQL only — no vector DB, no in-memory fuzzy matching

## Architecture

Two Docker containers, one codebase:

- **api** (`src/main.ts`): HTTP — webhooks, auth/team, jobs CRUD, candidates, applications, health
- **worker** (`src/worker.ts`): BullMQ consumer — ingestion pipeline (extract → dedup → score → store)

API modules: `webhooks`, `auth` (+ team), `candidates`, `jobs`, `applications`, `health`,
`config`, `pm-bridge` (Jira). Worker modules: `ingestion`, `scoring`, `dedup`, `storage`.

## Conventions

- `text` + CHECK constraints over PostgreSQL ENUMs (ENUMs need a migration to add values)
- No binary blobs in DB; `updated_at` via Prisma `@updatedAt`
- `tenant_id` on every table from day 1 (multi-tenancy baked in to avoid a schema rewrite later)

## Commands

```bash
npm run docker:up          # Start all services (API + worker + Postgres + Redis)
npm run docker:up:build    # Rebuild before starting
npm run docker:logs        # Tail all logs (:api / :worker for one)
npm run db:migrate         # Run Prisma migrations inside container
npm run db:studio          # Open Prisma Studio locally (needs docker:up running first)
npm test                   # Unit tests
npm run ngrok              # Expose webhook endpoint via ngrok
```

## Required Environment Variables

```
DATABASE_URL                  # postgresql://...
REDIS_URL                     # redis://...
OPENROUTER_API_KEY
MAILGUN_WEBHOOK_SIGNING_KEY   # verifies inbound Mailgun webhooks
TENANT_ID                     # UUID of the default tenant
R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME

# Auth (API process)
JWT_SECRET                    # ≥32 chars — signs sessions/tokens
GOOGLE_CLIENT_ID              # optional — Google OAuth sign-in
FRONTEND_URL                  # default http://localhost:5173 — used in magic-link / invite emails
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM   # outbound auth email (Mailgun SMTP)

# PM Bridge — Jira integration
JIRA_BASE_URL                 # https://triolla.atlassian.net
JIRA_EMAIL / JIRA_API_TOKEN   # Basic auth (token never logged)
JIRA_PROJECT_KEY              # default: TO
JIRA_BOARD_ID                 # board whose *active* sprint new issues join, resolved live (e.g. 137)
JIRA_SPRINT_ID                # optional override — pin issues to a fixed sprint instead of the active one
PM_BRIDGE_ALLOWLIST           # comma-separated emails allowed to use PM Bridge (default: none)
PM_BRIDGE_MODEL               # OpenRouter model for draft+validate (default: anthropic/claude-sonnet-4.6)
JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID  # Jira accountId every issue is assigned to (Daniel)
JIRA_DEFAULT_ASSIGNEE_EMAIL       # optional — fallback to look up the accountId at runtime
PM_HOLD_NOTIFY_EMAIL              # who gets held-item emails (default daniel.s@triolla.io)
PM_HOLD_TOKEN_SECRET             # ≥32 chars — signs approve/reject email links (NOT JWT_SECRET)
API_PUBLIC_URL                   # optional — public base URL of the API for email links

# Voice screening (ElevenLabs) — all optional; feature is fail-closed until configured
ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID / ELEVENLABS_AGENT_PHONE_NUMBER_ID   # api + worker
ELEVENLABS_WEBHOOK_SECRET     # api only — HMAC for POST /webhooks/elevenlabs
ELEVENLABS_TELEPHONY          # 'twilio' | 'sip' (default) — how the number is imported in ElevenLabs
VOICE_CALL_MODE               # 'test' (default, allowlist enforced) | 'live'
VOICE_CALL_ALLOWLIST          # comma-separated E.164 numbers callable in test mode; empty = block all
```
