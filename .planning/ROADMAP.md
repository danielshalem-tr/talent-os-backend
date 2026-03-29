# Roadmap: Triolla Talent OS — Backend (Phase 1)

**Created:** 2026-03-22
**Phases:** 14
**Granularity:** Standard
**Coverage:** 40/40 v1 requirements mapped

## Phases

- [x] **Phase 1: Foundation** - Database schema, NestJS bootstrap, environment validation (completed 2026-03-22)
- [x] **Phase 2: Webhook Intake & Idempotency** - Postmark webhook endpoint, HMAC verification, message ID tracking (completed 2026-03-22)
- [x] **Phase 3: Processing Pipeline & Spam Filter** - Email parsing (PDF/DOCX), spam pre-filtering before LLM (completed 2026-03-22)
- [x] **Phase 4: AI Extraction** - Claude Haiku agent extracts structured candidate fields (completed 2026-03-22)
- [x] **Phase 5: File Storage** - Original CV files uploaded to Cloudflare R2 (completed 2026-03-22)
- [x] **Phase 6: Duplicate Detection** - pg_trgm fuzzy matching, duplicate flags for human review (completed 2026-03-23)
- [x] **Phase 7: Candidate Storage & Scoring** - Store candidates, score against active jobs with Claude Sonnet (completed 2026-03-23)
- [x] **Phase 8: Phase 1 Verification** - Write VERIFICATION.md for Phase 1 foundation, close stale PROC-01/INFR-04/INFR-05 checkboxes (completed 2026-03-23)
- [x] **Phase 9: Create client-facing REST API endpoints** - GET /api/candidates, /jobs, /applications endpoints (completed 2026-03-23)
- [x] **Phase 10: Add job creation feature** - POST /api/jobs with atomic nested creation and default seeding (completed 2026-03-24)
- [x] **Phase 11: API Protocol MVP Implementation** - Complete job management endpoints with full validation and testing (completed 2026-03-25)

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

**Plans:** 3/3 plans complete

Plans:
- [x] 01-01-PLAN.md — Install dependencies, clean scaffold, bootstrap main.ts + worker.ts + env validation + PrismaService
- [x] 01-02-PLAN.md — Prisma schema (7 tables), initial migration, pg_trgm indexes, seed data
- [x] 01-03-PLAN.md — Dockerfile (multi-stage), docker-compose.yml (4 services + health checks), .env.example

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

**Plans:** 3/3 plans complete

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

**Plans:** 3/3 plans complete

Plans:
- [x] 04-00-PLAN.md — Wave 0: Create extraction-agent.service.spec.ts stub + minimal service stub
- [x] 04-01-PLAN.md — Implement ExtractionAgentService (mock) with CandidateExtractSchema and 5 unit tests
- [x] 04-02-PLAN.md — Wire ExtractionAgentService into IngestionProcessor and IngestionModule; 2 integration tests

### Phase 5: File Storage

**Goal:** Original CV files (PDF/DOCX) persisted to Cloudflare R2; URL stored in database.

**Depends on:** Phase 4

**Requirements:** STOR-01, STOR-02, STOR-03

**Success Criteria** (what must be TRUE):
1. Original CV file uploaded to R2 at path cvs/{tenantId}/{messageId} before duplicate detection runs
2. R2 file URL stored in candidates.cv_file_url; file remains accessible after Postmark webhook delivery
3. Full extracted CV text stored in candidates.cv_text (PostgreSQL); no binary blobs in database

**Plans:** 3/3 plans complete

Plans:
- [x] 05-00-PLAN.md — Wave 1: Create StorageService stub, StorageModule, and failing test scaffolds (Nyquist setup)
- [x] 05-01-PLAN.md — Wave 2: Implement StorageService (S3Client, attachment selection, R2 upload); 5 unit tests green
- [x] 05-02-PLAN.md — Wave 3: Wire StorageService into IngestionProcessor + IngestionModule; extend ProcessingContext; 3 integration tests green

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

**Plans:** 3/3 plans complete

Plans:
- [x] 06-00-PLAN.md — Wave 0: DedupModule skeleton, DedupService stub, 5+3 it.todo test stubs, ai_summary migration
- [x] 06-01-PLAN.md — Wave 1: Implement DedupService (check/insertCandidate/upsertCandidate/createFlag); 5 unit tests green
- [x] 06-02-PLAN.md — Wave 2: Wire DedupService into IngestionProcessor + IngestionModule; extend ProcessingContext; 3 integration tests green

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

**Plans:** 2/2 plans complete

Plans:
- [x] 07-01-PLAN.md — Wave 1: Create ScoringModule + ScoringAgentService (mock-first, real call scaffolded); 3 unit tests
- [x] 07-02-PLAN.md — Wave 2: Implement Phase 7 in IngestionProcessor (enrichment + scoring loop + terminal status); wire ScoringModule; 5 integration tests

### Phase 8: Phase 1 Verification

**Goal:** Close the v1.0 audit gap — write the missing Phase 1 VERIFICATION.md and update stale REQUIREMENTS.md checkboxes for PROC-01, INFR-04, and INFR-05.

**Depends on:** Phase 7 (all implementation complete)

**Requirements:** PROC-01, INFR-04, INFR-05

**Gap Closure:** Closes gaps from v1.0-MILESTONE-AUDIT.md

**Success Criteria** (what must be TRUE):
1. `phases/01-foundation/VERIFICATION.md` exists and confirms docker-compose.yml, .env.example, and Worker bootstrap meet Phase 1 success criteria
2. PROC-01, INFR-04, INFR-05 checkboxes marked `[x]` in REQUIREMENTS.md
3. Traceability table updated: PROC-01, INFR-04, INFR-05 → Phase 8, Status: Complete

**Plans:** 1/1 plans complete

Plans:
- [x] 08-01-PLAN.md — Write 01-VERIFICATION.md (15 requirements) and tick PROC-01/INFR-04/INFR-05 checkboxes in REQUIREMENTS.md

### Phase 9: Create client-facing REST API endpoints

**Goal:** Expose three read-only REST API endpoints for the recruiter UI: GET /api/candidates (with search + filter), GET /api/jobs (with candidate_count), and GET /api/applications (with nested candidate + ai_score). Includes CORS for localhost:5173 and global /api prefix.

**Depends on:** Phase 8

**Requirements:** RAPI-01

**Plans:** 3/3 plans complete

Plans:
- [x] 09-01-PLAN.md — Wave 1: CandidatesModule (GET /candidates with q + filter params, ai_score, is_duplicate)
- [x] 09-02-PLAN.md — Wave 1: JobsModule (GET /jobs with candidate_count) + ApplicationsModule (GET /applications with nested candidate)
- [x] 09-03-PLAN.md — Wave 2: Wire modules into AppModule, add CORS + global prefix to main.ts, human smoke test

### Phase 10: Add job creation feature

**Goal:** Add POST /api/jobs endpoint with atomic nested creation of JobStage and ScreeningQuestion records; auto-seed 4 default hiring stages per job; additive schema migration only (no field removals).

**Depends on:** Phase 9

**Requirements:** D-01, D-02, D-03, D-04, D-05, D-06, D-07, D-08, D-09, D-10

**Plans:** 4/4 plans complete

Plans:
- [x] 10-00-PLAN.md — Wave 0: Create 3 test stub files (jobs.service.spec.ts, jobs.controller.spec.ts, jobs.integration.spec.ts) with it.todo stubs
- [x] 10-01-PLAN.md — Wave 1: Prisma schema migration — add JobStage + ScreeningQuestion models, extend Job + Application; run prisma migrate dev
- [x] 10-02-PLAN.md — Wave 2: Create src/jobs/dto/create-job.dto.ts (Zod schemas); implement JobsService.createJob() with default stage seeding; 7 unit tests green
- [x] 10-03-PLAN.md — Wave 3: Add @Post() to JobsController with Zod validation; fill integration tests; human smoke test checkpoint

### Phase 11: API Protocol MVP Implementation

**Goal:** Implement complete API protocol MVP specification: update database schema (JobStage interviewer/is_enabled, ScreeningQuestion expected_answer), complete all 5 job management endpoints (GET /config, GET /jobs, POST /jobs, PUT /jobs/:id, DELETE /jobs/:id), validation and error handling per spec, tenant isolation, and comprehensive integration tests.

**Depends on:** Phase 10

**Requirements:** API_PROTOCOL_MVP_SCHEMA_UPDATES, API_PROTOCOL_MVP_ENDPOINTS, API_PROTOCOL_MVP_VALIDATION, API_PROTOCOL_MVP_TESTING

**Success Criteria** (what must be TRUE):
1. Prisma schema updated: JobStage has `interviewer` (TEXT, nullable) and `isEnabled` (BOOLEAN, default true); ScreeningQuestion has `expectedAnswer` (VARCHAR, nullable)
2. GET /config returns hardcoded response with 6 lookup tables and 4 default hiring stages with correct Tailwind colors
3. GET /jobs returns complete job data with nested hiring_flow and screening_questions, all fields matching API_PROTOCOL_MVP.md, snake_case field names
4. POST /jobs creates jobs atomically, seeds 4 default stages if none provided, validates all required fields, rejects if all stages disabled
5. PUT /jobs/:id updates job fields independently, atomically recreates stages/questions (omitted = removed), validates at least one stage enabled
6. DELETE /jobs/:id soft-deletes (status=closed, no hard delete), returns 204 No Content
7. All endpoints enforce tenant isolation via ConfigService TENANT_ID
8. All error responses use standard format with code, message, details
9. Screening question responses use `type` field (not `answerType`), hide `required`/`knockout` fields
10. Hiring stage responses include `color` field (stored in DB for consistency with default stages)
11. Integration tests pass covering all endpoints, validation scenarios, tenant isolation, and response formats

**Plans:** 1/1 plans complete

Plans:
- [x] 11-01-PLAN.md — Schema migrations (JobStage+ScreeningQuestion), GET /config endpoint, Jobs endpoints (GET/POST/PUT/DELETE), validation, error handling, 195 tests passing

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 3/3 | Complete | 2026-03-22 |
| 2. Webhook Intake & Idempotency | 3/3 | Complete | 2026-03-22 |
| 3. Processing Pipeline & Spam Filter | 4/4 | Complete | 2026-03-22 |
| 4. AI Extraction | 3/3 | Complete | 2026-03-22 |
| 5. File Storage | 3/3 | Complete | 2026-03-22 |
| 6. Duplicate Detection | 3/3 | Complete | 2026-03-23 |
| 7. Candidate Storage & Scoring | 2/2 | Complete | 2026-03-23 |
| 8. Phase 1 Verification | 1/1 | Complete | 2026-03-23 |
| 9. Client-facing REST API | 3/3 | Complete | 2026-03-23 |
| 10. Add job creation feature | 4/4 | Complete | 2026-03-24 |
| 11. API Protocol MVP Implementation | 1/1 | Complete    | 2026-03-25 |
| 12. Support add candidate from the UI | 1/1 | Planned | 2026-03-26 |
| 13. Implement Kanban board with candidate hiring stage tracking | 1/1 | Planned | 2026-03-26 |
| 14. Wire OpenRouter extraction pipeline | 1/3 | In Progress|  |

### Phase 12: Support add candidate from the UI

**Goal:** Enable recruiters to add candidates directly via the UI (not just via email webhooks). Support full candidate creation flow with file attachments.

**Depends on:** Phase 11

**Plans:** 1 plan

Plans:
- [x] 12-01-PLAN.md — Full implementation (researched, context gathered, plan written)

### Phase 13: Implement Kanban board with candidate hiring stage tracking

**Goal:** Track candidates' current hiring stage directly on the Candidate entity, auto-assign the first stage when a candidate is created, and expose stage information in API responses for Kanban board UI rendering.

**Depends on:** Phase 11

**Requirements:** KANBAN-01, KANBAN-02, KANBAN-03, KANBAN-04, KANBAN-05

**Success Criteria** (what must be TRUE):
1. Candidate model has `hiring_stage_id` FK field pointing to JobStage
2. CandidatesService.createCandidate() auto-assigns first JobStage (by position order) to new candidates
3. GET /api/candidates response includes job_id, hiring_stage_id, hiring_stage_name for Kanban board rendering
4. Existing candidates with job_id backfilled with first stage via Prisma migration
5. Data integrity enforced: if job_id is NOT NULL, hiring_stage_id must also be NOT NULL
6. All existing tests pass; zero breaking changes to API contract (additive fields only)

**Plans:** 1/1 plan

Plans:
- [x] 13-01-PLAN.md — Wave 1: Schema update, migration with 3-step backfill, service logic, API response extension, tests

### Phase 14: Wire OpenRouter extraction pipeline: email→LLM→dedup→scoring→UI

**Goal:** Fix critical bugs and gaps in the email-to-candidate pipeline: error swallowing prevents BullMQ retries; schema missing 4 fields (currentRole, yearsExperience, location, source_hint); scoring is a hardcoded mock (score=72 always); deterministic fallback is dead code. After this phase: extraction errors propagate correctly, all candidate fields extracted, real Gemini LLM scoring via OpenRouter, deterministic fallback on final BullMQ attempt.

**Depends on:** Phase 13

**Requirements:** AIEX-01, AIEX-02, AIEX-03, CAND-01, CAND-02, CAND-03, SCOR-01, SCOR-02, SCOR-03, SCOR-04, SCOR-05

**Success Criteria** (what must be TRUE):
1. CandidateExtractSchema has 9 fields: full_name, email, phone, current_role, years_experience, location, skills, ai_summary, source_hint
2. extract() throws on API error (no more silent fallback swallowing); BullMQ retries on transient failures
3. On final BullMQ attempt (3/3), extractDeterministically() is called before marking job failed
4. ScoringAgentService calls OpenRouter with google/gemini-2.0-flash:free (no hardcoded score=72)
5. Phase 7 candidate.update sets currentRole, yearsExperience, location from extraction (not null)
6. DedupService.insertCandidate() uses extraction.source_hint for source field (not always 'direct')
7. Full npm test suite passes with all new tests green

**Plans:** 1/3 plans executed

Plans:
- [ ] 14-01-PLAN.md — Wave 1A: Extend CandidateExtractSchema (9 fields), fix extract() error handling, update signatures, update test helpers
- [ ] 14-02-PLAN.md — Wave 1B: Replace mock ScoringAgentService with real OpenRouter call, add ConfigModule to ScoringModule
- [x] 14-03-PLAN.md — Wave 2: Update processor (metadata, enrichment fields, deterministic fallback), DedupService source param, 5 new integration tests

---

*Roadmap created: 2026-03-22 by /gsd:new-roadmap*
*Updated: 2026-03-29 by plan-phase (Phase 14 planning complete)*
