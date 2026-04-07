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
- [x] Agent 1 (openai/gpt-4o-mini via OpenRouter): ExtractionAgentService with CandidateExtractSchema (8 fields, Zod), extract() wired into IngestionProcessor with fullName failure handling — *Validated in Phase 4 (mock), real calls enabled in Phase 14*
- [x] API and Worker run as separate processes (separate Docker containers) — CPU-heavy work never blocks webhook receipt — *Validated in Phase 8: Phase 1 Verification*
- [x] Environment variables validated at startup via @nestjs/config + Zod — *Validated in Phase 8: Phase 1 Verification*
- [x] Docker Compose runs identically locally and on Hetzner VPS — *Validated in Phase 8: Phase 1 Verification*

### Active (Validated)

- [x] Postmark inbound webhook receives CV emails and verifies HMAC-SHA256 signature — *Validated in Phase 2*
- [x] Idempotency: duplicate webhook deliveries are detected via `MessageID` and silently skipped — *Validated in Phase 2*
- [x] Agent 1 (openai/gpt-4o-mini via OpenRouter): real API call enabled — @openrouter/sdk with JSON mode (completed Phase 14, quick task 260324-agv)
- [x] Original CV file is uploaded to Cloudflare R2 before dedup (Postmark does not retain attachments) — *Validated in Phase 5: File Storage*
- [x] Duplicate detection runs in PostgreSQL via pg_trgm — no candidates loaded into memory — *Validated in Phase 6: Duplicate Detection*
- [x] Exact email match → UPSERT; fuzzy match → INSERT new + `duplicate_flags` row for human review — *Validated in Phase 6*
- [x] Agent 2 (openai/gpt-4o-mini via OpenRouter): scores candidate against each active job; results stored append-only in `candidate_job_scores` — *Validated in Phase 7*
- [x] Multi-tenant schema from day 1: `tenant_id` on every table; Phase 1 has exactly one tenant — *Validated in Phase 1 (DB-02)*

### Out of Scope

- ~~Recruiter-facing REST API — Phase 2~~ — *Delivered in Phase 9: GET /api/candidates, /api/jobs, /api/applications live*
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
- **AI cost:** ~$6–16/month total (openai/gpt-4o-mini for extraction and scoring via OpenRouter, PostgreSQL for dedup — no LLM cost).
- **Infra cost:** ~€5/month on Hetzner CX21 (2 vCPU, 4GB RAM). Stack uses ~1.5–2GB RAM without Ollama.
- **Spec:** Full architecture is documented in `spec/backend-architecture-proposal.md` (approved 2026-03-19).
- **DB schema:** 7 tables — `tenants`, `jobs`, `candidates`, `applications`, `candidate_job_scores`, `duplicate_flags`, `email_intake_log`.
- **Open questions for Phase 2 (not blockers):** outbound email provider, recruiter auth solution, voice screening approach, monitoring tooling (Sentry + BullMQ dashboard recommended).
- **Auth note:** Postmark inbound webhooks use a different auth mechanism than delivery/bounce webhooks — verify exact method before implementing `verifySignature`.

## Constraints

- **Tech Stack:** TypeScript only, NestJS 11, BullMQ + Redis, Prisma 7, PostgreSQL 16 — locked, not negotiable
- **AI Provider:** OpenRouter via `@openrouter/sdk` — currently `openai/gpt-4o-mini` for both extraction and scoring
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
| @openrouter/sdk over Vercel AI SDK | Single provider for all models, no per-model SDK, easy model swap via model string | Adopted in Phase 14 (260324-agv) |
| Hetzner VPS over AWS | ~€5/month vs ~$15/month; Docker Compose is identical on both — migrate later if needed | — Pending |
| Prisma over raw SQL / Drizzle | Schema as single source of truth, type-safe, clean migration tooling | — Pending |
| Zod for all structured AI outputs | Type-safe AI responses; same schema used for validation and TypeScript types | — Pending |

## Current State

**v1.0 Milestone Complete (2026-04-07)**

All 17 phases delivered end-to-end (email intake pipeline, OpenRouter extraction, pg_trgm dedup, recruiter API, production deployment).

**v2.0 Milestone Planning Started (2026-04-07)**

Focus: Organization signup, admin user management, role-based access control. 5 phases planned in agile structure (Phase 18–22); no strict order required but Phase 18 is prerequisite.

### v1.0 Deliverables
1. **Foundation** — Database schema (7 tables, tenant_id everywhere), NestJS + BullMQ worker, environment validation
2. **Webhook Intake** — Postmark inbound webhooks, HMAC verification, idempotency via MessageID
3. **Processing Pipeline** — PDF/DOCX parsing, spam pre-filtering (no attachment, marketing keywords)
4. **AI Extraction** — OpenRouter via @openrouter/sdk, openai/gpt-4o-mini model, Zod schema validation
5. **File Storage** — Cloudflare R2 for original CV files, cv_text stored in PostgreSQL
6. **Duplicate Detection** — pg_trgm fuzzy matching, duplicate flags for human review (never auto-merge)
7. **Candidate Scoring** — Score candidates against each active job, append-only score history
8. **Phase 1 Verification** — VERIFICATION.md written, PROC-01/INFR-04/INFR-05 requirements closed
9. **Recruiter API** — GET /api/candidates, /jobs, /applications endpoints with search/filter
10. **Job Creation** — POST /api/jobs with atomic nested JobStage + ScreeningQuestion seeding
11. **API Protocol MVP** — Full job management (GET/POST/PUT/DELETE), validation, tenant isolation
12. **Add Candidate from UI** — POST /candidates endpoint with R2 multipart upload
13. **Kanban Board** — Application stage tracking (new → screening → interview → offer → hired/rejected)
14. **OpenRouter Pipeline** — Real LLM extraction calls replacing mock, email → scoring fully live
15. **Deterministic Job Routing** — Regex + shortId lookup replacing semantic matching (cost: $0, latency: 2ms)
16. **Manual Candidate Routing** — PATCH /candidates/:id supports reassignment with atomic scoring
17. **Production Readiness** — Health endpoint, nestjs-pino logging, helmet + CORS security, GitHub Actions CI/CD

**Quality Metrics:**
- 250+ tests passing across 20 suites
- 0 TypeScript errors
- 100% requirement coverage (40/40 v1 requirements mapped and validated)
- Production-ready: Hetzner CX21 deployment-ready, docker-compose with healthchecks, structured logging

## v2.0 Focus: Organization Signup & Admin User Management

**Core Value:** Organization-level signup + admin-managed team access + role-based recruiter workflows.

**Key Changes from v1.0:**
- v1.0: Single hardcoded tenant, no auth, API-only (no recruiter login)
- v2.0: Multi-tenant signup, JWT auth, user roles (admin/recruiter/viewer), org management

**5 Planned Phases (Agile):**
1. **Phase 18** (prereq): Database schema (organizations + users tables) + JWT service
2. **Phase 19:** POST /auth/signup endpoint (org creation + admin user)
3. **Phase 20:** Admin user management (POST/GET/PUT/DELETE /api/admin/users)
4. **Phase 21:** JWT auth middleware + role-based guards on all API endpoints
5. **Phase 22:** Login + token refresh endpoints (complete auth flow)

**Recommended execution order:** 18 → 19 → 20/21/22 (20/21/22 can be parallel after 18 complete)

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
*Last updated: 2026-04-07 after v2.0 milestone planning — 5 phases defined (18–22), agile structure (Phase 18 prerequisite, 19–22 flexible order)*
