# Requirements: Triolla Talent OS — Backend

**Defined:** 2026-03-22
**Core Value:** Inbound CVs are automatically processed, de-duplicated, and scored against open jobs without any manual recruiter effort — end-to-end from email receipt to scored candidate record.

## v1 Requirements

### Webhook Intake

- [ ] **WBHK-01**: System receives Postmark inbound webhook POST at `POST /webhooks/email` and responds within 100ms
- [ ] **WBHK-02**: System verifies Postmark webhook signature (HMAC-SHA256) and returns 401 if invalid — prevents unauthorized record injection
- [ ] **WBHK-03**: System checks `MessageID` against `email_intake_log` before enqueuing — duplicate webhook deliveries are silently skipped
- [ ] **WBHK-04**: System inserts `email_intake_log` row (status: `pending`) before enqueuing — this row is the idempotency guard
- [ ] **WBHK-05**: System enqueues job to BullMQ `ingest-email` queue with 3 retry attempts and exponential backoff on success
- [ ] **WBHK-06**: Raw Postmark payload stored in `email_intake_log.raw_payload` with attachment binary blobs stripped

### Processing Pipeline

- [ ] **PROC-01**: API and Worker run as separate Docker containers — CPU-heavy processing cannot block webhook receipt
- [ ] **PROC-02**: Spam pre-filter discards emails with no attachment AND body < 100 chars before any LLM call
- [ ] **PROC-03**: Spam pre-filter discards emails with marketing keywords in subject (`unsubscribe`, `newsletter`, `promotion`, `deal`, `offer`) before any LLM call
- [ ] **PROC-04**: System extracts plain text from PDF attachments via `pdf-parse`
- [ ] **PROC-05**: System extracts plain text from DOCX attachments via `mammoth`
- [ ] **PROC-06**: System marks `email_intake_log` as `spam` and stops processing when spam filter rejects email

### AI Extraction

- [ ] **AIEX-01**: Agent 1 (claude-haiku-4-5) extracts structured candidate fields from email + CV text using Vercel AI SDK `generateObject` + Zod schema
- [ ] **AIEX-02**: Extracted schema includes: `fullName`, `email`, `phone`, `currentRole`, `yearsExperience`, `skills[]`, `summary` (2-sentence AI summary), `source` enum
- [ ] **AIEX-03**: All extracted fields are nullable (except `fullName`) — agent never throws on missing fields

### File Storage

- [ ] **STOR-01**: Original CV file (PDF/DOCX) is uploaded to Cloudflare R2 at path `cvs/{tenantId}/{messageId}` before duplicate detection
- [ ] **STOR-02**: R2 file URL is stored in `candidates.cv_file_url` — Postmark does not retain attachments after delivery
- [ ] **STOR-03**: Full extracted CV text is stored in `candidates.cv_text` (PostgreSQL)

### Duplicate Detection

- [ ] **DEDUP-01**: Dedup runs entirely in PostgreSQL via `pg_trgm` extension — no candidates loaded into application memory
- [ ] **DEDUP-02**: Exact email match (`confidence = 1.0`) → UPSERT existing candidate record
- [ ] **DEDUP-03**: Fuzzy name match (`similarity > 0.7`, `confidence < 1.0`) → INSERT new candidate + create `duplicate_flags` row for human review
- [ ] **DEDUP-04**: No match → INSERT new candidate record
- [ ] **DEDUP-05**: System never auto-merges on fuzzy match — creates `duplicate_flags` with `reviewed = false`
- [ ] **DEDUP-06**: `pg_trgm` GIN indexes on `candidates.full_name` and `candidates.phone` are created in migration

### Candidate Storage

- [ ] **CAND-01**: `candidates` table stores AI-extracted fields plus `cv_text`, `cv_file_url`, `source`, `source_email`, `source_agency`, `metadata` JSONB
- [ ] **CAND-02**: `candidates` table has UNIQUE index on `(tenant_id, email) WHERE email IS NOT NULL`
- [ ] **CAND-03**: `email_intake_log.candidate_id` is set after successful candidate creation

### AI Scoring

- [ ] **SCOR-01**: Scoring processor fetches all active jobs for the tenant from `jobs` table (`WHERE status = 'active'`)
- [ ] **SCOR-02**: Scoring processor upserts an `applications` row (`stage = 'new'`) for each candidate-job pair before scoring — idempotent on retry
- [ ] **SCOR-03**: Agent 2 (claude-sonnet-4-6) scores candidate against each active job and returns: `score` (0–100), `reasoning`, `strengths[]`, `gaps[]`
- [ ] **SCOR-04**: Score result is inserted append-only into `candidate_job_scores` — existing scores are never updated
- [ ] **SCOR-05**: `candidate_job_scores` records the `model_used` string (e.g., `claude-sonnet-4-6`)

### Database Schema

- [ ] **DB-01**: 7 tables created via Prisma migration: `tenants`, `jobs`, `candidates`, `applications`, `candidate_job_scores`, `duplicate_flags`, `email_intake_log`
- [ ] **DB-02**: Every table carries `tenant_id` FK → `tenants.id` from day 1 — no schema rewrite required for multi-tenancy
- [ ] **DB-03**: Status/type columns use `text` + CHECK constraints (not PostgreSQL ENUMs) — adding values requires no migration
- [ ] **DB-04**: `updated_at` maintained by Prisma `@updatedAt` directive, not DB triggers
- [ ] **DB-05**: No binary blobs stored in database — original files go to R2, only URL stored
- [ ] **DB-06**: `applications` has UNIQUE constraint `(tenant_id, candidate_id, job_id)`
- [ ] **DB-07**: `duplicate_flags` has UNIQUE constraint `(tenant_id, candidate_id, matched_candidate_id)` — prevents duplicate flags on worker retries
- [ ] **DB-08**: `email_intake_log` has UNIQUE constraint `(tenant_id, message_id)` — primary idempotency guard
- [ ] **DB-09**: All required indexes created in migration (active jobs, application stage, score lookup, unreviewed duplicates, intake status)

### Infrastructure

- [ ] **INFR-01**: `main.ts` bootstraps NestJS with `rawBody: true` for HMAC signature verification
- [ ] **INFR-02**: `worker.ts` bootstraps BullMQ worker with no HTTP layer
- [ ] **INFR-03**: Environment variables validated at startup via `@nestjs/config` + Zod — application fails fast on missing config
- [ ] **INFR-04**: Docker Compose defines: `api`, `worker`, `postgres` (16-alpine), `redis` (7-alpine) services
- [ ] **INFR-05**: `.env.example` documents all required environment variables: `DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`, `POSTMARK_WEBHOOK_TOKEN`, `TENANT_ID`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `NODE_ENV`

## v2 Requirements

### Recruiter API

- **RAPI-01**: REST API endpoints for reading candidates, applications, scores
- **RAPI-02**: Authentication (JWT / Clerk)
- **RAPI-03**: Application stage transition endpoints (screening → interview → offer → hired/rejected)
- **RAPI-04**: Duplicate flag review endpoint (mark as reviewed, merge decision)

### Recruiter UI Integration

- **UI-01**: UI consumes recruiter API to display candidate pipeline
- **UI-02**: Duplicate flag review UI for recruiter decisions

### Outreach

- **OUTR-01**: Outbound email agent for candidate outreach
- **OUTR-02**: Voice screening agent

### Operations

- **OPS-01**: Sentry error tracking integration
- **OPS-02**: BullMQ dashboard for queue health monitoring
- **OPS-03**: Multi-tenant registration flow

## Out of Scope

| Feature | Reason |
|---------|--------|
| Local LLMs (Ollama) | Only when monthly LLM cost > ~$100/month — currently ~$6–16 |
| Vector DB for dedup | pg_trgm sufficient at this scale, zero extra infra |
| Real-time events (WebSockets) | Phase 1 is purely reactive — no UI in Phase 1 |
| Fine-tuning / RAG | Future — not needed at 500 CVs/month |
| Multi-tenant registration | Phase 2 — one hardcoded tenant in Phase 1 |
| Gmail API polling | Postmark covers Phase 1; Gmail is a fallback only if client insists |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| WBHK-01 | Phase 2 | Pending |
| WBHK-02 | Phase 2 | Pending |
| WBHK-03 | Phase 2 | Pending |
| WBHK-04 | Phase 2 | Pending |
| WBHK-05 | Phase 2 | Pending |
| WBHK-06 | Phase 2 | Pending |
| PROC-01 | Phase 1 | Pending |
| PROC-02 | Phase 3 | Pending |
| PROC-03 | Phase 3 | Pending |
| PROC-04 | Phase 3 | Pending |
| PROC-05 | Phase 3 | Pending |
| PROC-06 | Phase 3 | Pending |
| AIEX-01 | Phase 4 | Pending |
| AIEX-02 | Phase 4 | Pending |
| AIEX-03 | Phase 4 | Pending |
| STOR-01 | Phase 5 | Pending |
| STOR-02 | Phase 5 | Pending |
| STOR-03 | Phase 5 | Pending |
| DEDUP-01 | Phase 6 | Pending |
| DEDUP-02 | Phase 6 | Pending |
| DEDUP-03 | Phase 6 | Pending |
| DEDUP-04 | Phase 6 | Pending |
| DEDUP-05 | Phase 6 | Pending |
| DEDUP-06 | Phase 6 | Pending |
| CAND-01 | Phase 7 | Pending |
| CAND-02 | Phase 7 | Pending |
| CAND-03 | Phase 7 | Pending |
| SCOR-01 | Phase 7 | Pending |
| SCOR-02 | Phase 7 | Pending |
| SCOR-03 | Phase 7 | Pending |
| SCOR-04 | Phase 7 | Pending |
| SCOR-05 | Phase 7 | Pending |
| DB-01 | Phase 1 | Pending |
| DB-02 | Phase 1 | Pending |
| DB-03 | Phase 1 | Pending |
| DB-04 | Phase 1 | Pending |
| DB-05 | Phase 1 | Pending |
| DB-06 | Phase 1 | Pending |
| DB-07 | Phase 1 | Pending |
| DB-08 | Phase 1 | Pending |
| DB-09 | Phase 1 | Pending |
| INFR-01 | Phase 1 | Pending |
| INFR-02 | Phase 1 | Pending |
| INFR-03 | Phase 1 | Pending |
| INFR-04 | Phase 1 | Pending |
| INFR-05 | Phase 1 | Pending |

**Coverage:**
- v1 requirements: 40 total
- Mapped to phases: 40
- Unmapped: 0 ✓

---

*Requirements defined: 2026-03-22*
*Last updated: 2026-03-22 after roadmap creation*
