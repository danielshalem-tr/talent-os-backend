# Triolla Talent OS — Backend

## What This Is

An automated email intake pipeline for Triolla's recruiting platform. It receives CVs by email via Postmark webhooks, extracts candidate data using AI, detects duplicates, scores candidates against open positions, and stores everything in PostgreSQL — ready for the recruiter UI to consume in Phase 2. Phase 1 is purely reactive: no human-initiated writes, no auth, no UI.

## Core Value

Inbound CVs are automatically processed, de-duplicated, and scored against open jobs without any manual recruiter effort — the pipeline runs end-to-end from email receipt to scored candidate record.

## Requirements

### Validated

- [x] Postmark inbound webhook receives CV emails and verifies HTTP Basic Auth token — *Validated in Phase 2: Webhook Intake & Idempotency*
- [x] Idempotency: duplicate webhook deliveries are detected via `MessageID` and silently skipped — *Validated in Phase 2*
- [x] BullMQ enqueues jobs atomically with retry; attachment blobs stripped before DB write — *Validated in Phase 2*
- [x] API and Worker run as separate Docker containers — *Validated in Phase 2*

### Validated (cont.)

- [x] Spam pre-filter discards obvious non-CV emails before any LLM call — *Validated in Phase 3: Processing Pipeline*
- [x] PDF and DOCX attachments are parsed to plain text (pdf-parse + mammoth) — *Validated in Phase 3*
- [x] Agent 1 (Haiku): ExtractionAgentService with CandidateExtractSchema (8 fields, Zod), mock extract() wired into IngestionProcessor with fullName failure handling — *Validated in Phase 4: AI Extraction*

### Active

- [ ] Postmark inbound webhook receives CV emails and verifies HMAC-SHA256 signature
- [ ] Idempotency: duplicate webhook deliveries are detected via `MessageID` and silently skipped
- [ ] API and Worker run as separate processes (separate Docker containers) — CPU-heavy work never blocks webhook receipt
- [ ] Agent 1 (Haiku): real Anthropic generateObject call enabled (scaffolded in Phase 4, activated in Phase 5+)
- [x] Original CV file is uploaded to Cloudflare R2 before dedup (Postmark does not retain attachments) — *Validated in Phase 5: File Storage*
- [x] Duplicate detection runs in PostgreSQL via pg_trgm — no candidates loaded into memory — *Validated in Phase 6: Duplicate Detection*
- [x] Exact email match → UPSERT; fuzzy match → INSERT new + `duplicate_flags` row for human review — *Validated in Phase 6*
- [ ] Agent 2 (Sonnet): scores candidate against each active job; results stored append-only in `candidate_job_scores`
- [ ] Multi-tenant schema from day 1: `tenant_id` on every table; Phase 1 has exactly one tenant
- [ ] Environment variables validated at startup via @nestjs/config + Zod
- [ ] Docker Compose runs identically locally and on Hetzner VPS

### Out of Scope

- Recruiter-facing REST API — Phase 2, after pipeline is stable
- Authentication (JWT / Clerk) — Phase 2, no human requests in Phase 1
- UI integration — Phase 2
- Outbound email / outreach agent — Phase 2
- Voice screening — Phase 2+
- Local LLMs (Ollama) — Phase 2+ only if monthly LLM cost > ~$100
- Multi-tenant registration flow — Phase 2
- Fine-tuning / RAG — Future
- Real-time monitoring dashboard — recommended from day 1 but not blocking Phase 1

## Context

- **Scale:** ~500 CVs/month (~17/day). Low throughput. Performance is not a constraint.
- **AI cost:** ~$6–16/month total (Haiku for extraction, Sonnet for scoring, PostgreSQL for dedup — no LLM cost).
- **Infra cost:** ~€5/month on Hetzner CX21 (2 vCPU, 4GB RAM). Stack uses ~1.5–2GB RAM without Ollama.
- **Spec:** Full architecture is documented in `spec/backend-architecture-proposal.md` (approved 2026-03-19).
- **DB schema:** 7 tables — `tenants`, `jobs`, `candidates`, `applications`, `candidate_job_scores`, `duplicate_flags`, `email_intake_log`.
- **Open questions for Phase 2 (not blockers):** outbound email provider, recruiter auth solution, voice screening approach, monitoring tooling (Sentry + BullMQ dashboard recommended).
- **Auth note:** Postmark inbound webhooks use a different auth mechanism than delivery/bounce webhooks — verify exact method before implementing `verifySignature`.

## Constraints

- **Tech Stack:** TypeScript only, NestJS 11, BullMQ + Redis, Prisma 6, PostgreSQL 16, Vercel AI SDK — locked, not negotiable
- **AI Provider:** Anthropic Claude via `@ai-sdk/anthropic` — Haiku for extraction, Sonnet for scoring. No local models in Phase 1.
- **Storage:** Cloudflare R2 for original CV files (S3-compatible, 10GB free tier)
- **Email:** Postmark Inbound webhooks — no Gmail API polling in Phase 1
- **Dedup:** pg_trgm in PostgreSQL only — no in-memory fuzzy matching, no vector DB
- **DB conventions:** `text` + CHECK constraints over PostgreSQL ENUMs (ENUMs require migration to add values); no binary blobs in DB; `updated_at` via Prisma `@updatedAt`
- **Multi-tenancy:** `tenant_id` on every table from day 1 — prevents schema rewrite later

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| NestJS over Express/Fastify | TypeScript-first, modular, scales to full product without rewrite | — Pending |
| BullMQ + Redis for job queue | Decouples webhook receipt from slow AI processing; built-in retry + dead-letter | — Pending |
| Postmark Inbound over Gmail API | Push webhooks vs polling loop — simpler, no OAuth, parsed JSON payload | — Pending |
| pg_trgm for dedup over vector DB | Fuzzy matching in DB, no memory loading, scales naturally, zero extra infra | — Pending |
| Never auto-upsert on fuzzy match | Fuzzy match could be two different people — auto-merge silently corrupts data | — Pending |
| Cloudflare R2 for file storage | Postmark drops attachments after delivery — must persist on intake | — Pending |
| Vercel AI SDK over raw Anthropic SDK | One-line model swap (Haiku→Sonnet→Ollama) without touching agent logic | — Pending |
| Hetzner VPS over AWS | ~€5/month vs ~$15/month; Docker Compose is identical on both — migrate later if needed | — Pending |
| Prisma over raw SQL / Drizzle | Schema as single source of truth, type-safe, clean migration tooling | — Pending |
| Zod for all structured AI outputs | Type-safe AI responses; same schema used for validation and TypeScript types | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-23 after Phase 6 completion*
