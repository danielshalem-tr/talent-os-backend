# Roadmap: Triolla Talent OS — Backend (Phase 1)

**Created:** 2026-03-22
**Phases:** 7
**Granularity:** Standard
**Coverage:** 40/40 v1 requirements mapped

## Phases

- [ ] **Phase 1: Foundation** - Database schema, NestJS bootstrap, environment validation
- [ ] **Phase 2: Webhook Intake & Idempotency** - Postmark webhook endpoint, HMAC verification, message ID tracking
- [x] **Phase 3: Processing Pipeline & Spam Filter** - Email parsing (PDF/DOCX), spam pre-filtering before LLM (completed 2026-03-22)
- [ ] **Phase 4: AI Extraction** - Claude Haiku agent extracts structured candidate fields
- [ ] **Phase 5: File Storage** - Original CV files uploaded to Cloudflare R2
- [ ] **Phase 6: Duplicate Detection** - pg_trgm fuzzy matching, duplicate flags for human review
- [ ] **Phase 7: Candidate Storage & Scoring** - Store candidates, score against active jobs with Claude Sonnet

## Phase Details

### Phase 1: Foundation

**Goal:** Database schema created, NestJS app bootstrapped, environment validated, Worker process separated from API.

**Depends on:** Nothing (first phase)

**Requirements:** DB-01, DB-02, DB-03, DB-04, DB-05, DB-06, DB-07, DB-08, DB-09, INFR-01, INFR-02, INFR-03, INFR-04, INFR-05, PROC-01

**Success Criteria** (what must be TRUE):
1. PostgreSQL database with 7 tables (tenants, jobs, candidates, applications, candidate_job_scores, duplicate_flags, email_intake_log) created and accessible
2. Every table has `tenant_id` FK to tenants.id and all required constraints/indexes in place
3. NestJS API starts with `rawBody: true` for HMAC verification and serves HTTP requests
4. BullMQ Worker process starts independently with Redis connection and no HTTP layer
5. Environment variables validated at startup via @nestjs/config + Zod; app fails fast on missing config
6. Docker Compose runs all 4 services (api, worker, postgres, redis) locally with identical configuration to VPS

**Plans:** 2/3 plans executed

Plans:
- [x] 01-01-PLAN.md — Install dependencies, clean scaffold, bootstrap main.ts + worker.ts + env validation + PrismaService
- [x] 01-02-PLAN.md — Prisma schema (7 tables), initial migration, pg_trgm indexes, seed data
- [ ] 01-03-PLAN.md — Dockerfile (multi-stage), docker-compose.yml (4 services + health checks), .env.example

### Phase 2: Webhook Intake & Idempotency

**Goal:** System accepts Postmark inbound webhook POST requests, verifies authenticity, detects duplicate deliveries via MessageID, and enqueues jobs atomically.

**Depends on:** Phase 1

**Requirements:** WBHK-01, WBHK-02, WBHK-03, WBHK-04, WBHK-05, WBHK-06

**Success Criteria** (what must be TRUE):
1. POST /webhooks/email endpoint responds to Postmark inbound webhook payload within 100ms with 200 OK
2. Invalid HMAC-SHA256 signature returns 401 Unauthorized; valid signature allows processing
3. Duplicate MessageID against email_intake_log returns 200 OK silently (idempotent)
4. First receipt of MessageID: email_intake_log row inserted with status=pending before job enqueue
5. Job enqueued to BullMQ ingest-email queue with 3 retry attempts and exponential backoff
6. Raw Postmark payload stored in email_intake_log.raw_payload with attachment binary blobs stripped

**Plans:** 2/3 plans executed

Plans:
- [x] 02-01-PLAN.md — PostmarkPayloadDto (Zod), test spec scaffolds (guard/service/controller), IngestionProcessor stub
- [x] 02-02-PLAN.md — PostmarkAuthGuard (Basic Auth), WebhooksService (idempotency + enqueue + health), WebhooksController, WebhooksModule
- [x] 02-03-PLAN.md — Wire WebhooksModule into AppModule, IngestionModule into WorkerModule, human smoke test

### Phase 3: Processing Pipeline & Spam Filter

**Goal:** Email and CV attachments parsed to plain text; obvious non-CV emails discarded before any LLM call.

**Depends on:** Phase 2

**Requirements:** PROC-02, PROC-03, PROC-04, PROC-05, PROC-06

**Success Criteria** (what must be TRUE):
1. Emails with no attachment AND body < 100 chars marked as spam and processing stops
2. Emails with marketing keywords in subject (unsubscribe, newsletter, promotion, deal, offer) marked as spam and processing stops
3. PDF attachments parsed to plain text via pdf-parse and made available to extraction agent
4. DOCX attachments parsed to plain text via mammoth and made available to extraction agent
5. email_intake_log.status set to 'spam' for filtered emails; normal processing resumes only if spam filter passes

**Plans:** 4/4 plans complete

Plans:
- [x] 03-00-PLAN.md — Wave 0: Create 3 test spec stub files (spam-filter, attachment-extractor, processor integration)
- [x] 03-01-PLAN.md — Wave 1A: SpamFilterService (PROC-02, PROC-03) with 5 passing unit tests
- [x] 03-02-PLAN.md — Wave 1B: AttachmentExtractorService (PROC-04, PROC-05) with 5 passing unit tests
- [x] 03-03-PLAN.md — Wave 2: Fix Phase 2 blob-stripping, wire IngestionProcessor, update IngestionModule, 2 integration tests (PROC-06)

### Phase 4: AI Extraction

**Goal:** Claude Haiku agent extracts structured candidate data from email + CV text using Vercel AI SDK and Zod.

**Depends on:** Phase 3

**Requirements:** AIEX-01, AIEX-02, AIEX-03

**Success Criteria** (what must be TRUE):
1. Agent generates structured object with schema: fullName (required), email, phone, currentRole, yearsExperience, skills[], summary (2-sentence), source enum
2. All fields except fullName are nullable; agent never throws on missing optional fields
3. Extracted data returned as typed object matching Zod schema; Vercel AI SDK used for generateObject call

**Plans:** 3 plans

Plans:
- [ ] 04-00-PLAN.md — Wave 0: Create extraction-agent.service.spec.ts stub + minimal service stub
- [ ] 04-01-PLAN.md — Implement ExtractionAgentService (mock) with CandidateExtractSchema and 5 unit tests
- [ ] 04-02-PLAN.md — Wire ExtractionAgentService into IngestionProcessor and IngestionModule; 2 integration tests

### Phase 5: File Storage

**Goal:** Original CV files (PDF/DOCX) persisted to Cloudflare R2; URL stored in database.

**Depends on:** Phase 4

**Requirements:** STOR-01, STOR-02, STOR-03

**Success Criteria** (what must be TRUE):
1. Original CV file uploaded to R2 at path cvs/{tenantId}/{messageId} before duplicate detection runs
2. R2 file URL stored in candidates.cv_file_url; file remains accessible after Postmark webhook delivery
3. Full extracted CV text stored in candidates.cv_text (PostgreSQL); no binary blobs in database

**Plans:** TBD

### Phase 6: Duplicate Detection

**Goal:** PostgreSQL pg_trgm extension identifies exact and fuzzy matches; no in-memory candidate loading.

**Depends on:** Phase 5

**Requirements:** DEDUP-01, DEDUP-02, DEDUP-03, DEDUP-04, DEDUP-05, DEDUP-06

**Success Criteria** (what must be TRUE):
1. Exact email match (confidence = 1.0) triggers UPSERT of existing candidate record (idempotent on retry)
2. Fuzzy name match (similarity > 0.7, confidence < 1.0) creates new candidate + duplicate_flags row for human review; never auto-merges
3. No match on fuzzy check inserts new candidate record
4. pg_trgm GIN indexes on candidates.full_name and candidates.phone created in migration
5. Dedup runs entirely in PostgreSQL; zero candidates loaded into application memory

**Plans:** TBD

### Phase 7: Candidate Storage & Scoring

**Goal:** Candidates stored with all extracted fields, applications created for active jobs, and Claude Sonnet scores each candidate-job pair.

**Depends on:** Phase 6

**Requirements:** CAND-01, CAND-02, CAND-03, SCOR-01, SCOR-02, SCOR-03, SCOR-04, SCOR-05

**Success Criteria** (what must be TRUE):
1. Candidates table stores: AI-extracted fields, cv_text, cv_file_url, source, source_email, source_agency, metadata JSONB
2. UNIQUE index on (tenant_id, email) WHERE email IS NOT NULL prevents duplicate candidate emails per tenant
3. email_intake_log.candidate_id set after successful candidate creation
4. For each active job, applications row upserted with stage=new (idempotent on retry)
5. Claude Sonnet scores candidate against each active job; returns score (0–100), reasoning, strengths[], gaps[]
6. Scores inserted append-only to candidate_job_scores; existing scores never updated; model_used recorded

**Plans:** TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 2/3 | In Progress|  |
| 2. Webhook Intake & Idempotency | 2/3 | In Progress|  |
| 3. Processing Pipeline & Spam Filter | 4/4 | Complete   | 2026-03-22 |
| 4. AI Extraction | 0/3 | Not started | — |
| 5. File Storage | 0/2 | Not started | — |
| 6. Duplicate Detection | 0/3 | Not started | — |
| 7. Candidate Storage & Scoring | 0/4 | Not started | — |

---

*Roadmap created: 2026-03-22 by /gsd:new-roadmap*
