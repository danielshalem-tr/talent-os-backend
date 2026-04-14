# Roadmap: Triolla Talent OS — v1.0

**Archived:** 2026-04-07 — See [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) for full phase breakdown

All 17 phases complete: Email intake pipeline (Postmark → OpenRouter extraction → pg_trgm dedup → scoring → recruiter API), 250+ tests passing, production-ready with GitHub Actions CI and Hetzner deployment.

---

## v1.0 Milestone (Archived)

See [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) for complete phase details.

---

# Roadmap: Triolla Talent OS — Backend (Next Milestone - v2.0)

**Status:** Phases planned (agile — no strict order required)
**Focus:** Organization signup, admin user management, role-based access control
**Milestone Start:** 2026-04-07

## v2.0 Phase Structure

Core dependency: **Phase 18 must complete first** (database schema + session infrastructure). Phase 19 follows.

### Work Order

**Phase 18** (prerequisite) → **Phase 19** (all Auth API endpoints)

## Phase Details

### Phase 18: Database Schema & JWT Infrastructure

**Goal:** Add `organizations` and `users` tables to PostgreSQL schema; implement JWT token generation/validation infrastructure; no API endpoints yet.

**Depends on:** Nothing (database-only, no API changes)

**Requirements:** UM-01, UM-02, UM-03, UM-04, AUTH-01

**Success Criteria** (what must be TRUE):

1. `organizations` table: id (UUID PK), name (text), shortId (unique, varchar), created_by_user_id (FK users.id), created_at, updated_at
2. `users` table: id (UUID PK), email (text), password_hash (text), tenant_id/organization_id (FK organizations.id), role (text CHECK IN ('admin','recruiter','viewer')), full_name (text), is_active (boolean default true), created_at, updated_at
3. Unique constraint on (organization_id, email) prevents duplicate user accounts per org
4. JwtService scaffolded with sign() and verify() methods; JWT_SECRET loaded from env and validated at startup
5. Prisma migration runs cleanly; existing v1.0 data unaffected (add new tables only, no alter existing)

**Plans:** 1/1 plans complete

Plans:

- [x] 18-01-PLAN.md — Schema design (organizations + users tables), migration, JwtService scaffold, env validation

### Phase 19: Auth API Endpoints

**Goal:** Implement all Auth API endpoints from PROTOCOL.md section 7 — session management via HTTP-only cookies, Google OAuth verification, magic link login, invitation flow, and team management (members + invitations). All endpoints must match the contract exactly.

**Depends on:** Phase 18

**Requirements:** AUTH-001, AUTH-002, AUTH-003, AUTH-004, AUTH-005, AUTH-006, AUTH-007

**Success Criteria** (what must be TRUE):

1. `GET /auth/me` returns current session user or 401 when no session
2. `POST /auth/google/verify` accepts Google access_token, fetches user info from Google UserInfo API, creates Tenant+User (owner) on first sign-up, returns session via HTTP-only `talent_os_session` cookie
3. `POST /auth/logout` clears session cookie; returns `{ success: true }`
4. `POST /auth/onboarding` (multipart) saves org name + optional logo (R2); returns 409 if already completed
5. `GET /auth/invite/:token` returns `{ org_name, role, email }` or 404/409/410
6. `POST /auth/invite/:token/accept` creates user with invited role, marks invitation accepted, sets session cookie
7. `POST /auth/magic-link` sends magic link email; always returns 200 (no email enumeration)
8. `GET /auth/magic-link/verify` validates token, sets session cookie, redirects to `/`
9. `GET /auth/team/members` returns all active members for current tenant
10. `GET /auth/team/invitations` returns pending invitations for current tenant
11. `POST /auth/team/invitations` creates invitation + sends email; 409 on duplicate
12. `DELETE /auth/team/invitations/:id` cancels pending invitation
13. `PATCH /auth/team/members/:id/role` changes member role (Owner-only; cannot target Owner)
14. `DELETE /auth/team/members/:id` removes member immediately (Owner-only)
15. Google OAuth stub: code structured so `GOOGLE_CLIENT_ID` env var enables real verification; works in dev without it
16. All error responses use standard `{ error: { code, message, details? } }` format

**Plans:** 4/4 plans complete

Plans:

- [x] 19-01-PLAN.md — Schema migration (onboardingCompletedAt) + SessionGuard + EmailService + Wave 0 test stubs
- [x] 19-02-PLAN.md — Core session endpoints: GET /auth/me, POST /auth/google/verify, POST /auth/logout
- [x] 19-03-PLAN.md — Onboarding + magic link + invitation acceptance endpoints
- [x] 19-04-PLAN.md — Team management: members, invitations, role changes, member removal

## Phase 2: Webhook Intake & Idempotency (v1.0 - ARCHIVED)

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

### Phase 15: Migrate email ingestion to deterministic Job ID routing and remove semantic matching

**Goal:** Replace semantic job title matching (expensive LLM calls) with deterministic Job ID extraction from email subjects. Extract Job ID via regex pattern, look up job by new `shortId` field, route candidates atomically. Remove JobTitleMatcherService entirely. Unmatched candidates (no Job ID in subject) store with jobId=null and skip scoring.

**Depends on:** Phase 14

**Requirements:** [Phase 15 is a refactoring/migration phase; requirements are inherited from Phase 7 (CAND-01, CAND-02, CAND-03, SCOR-01, SCOR-02, SCOR-03, SCOR-04, SCOR-05)]

**Success Criteria** (what must be TRUE):

1. Job model has `shortId` field with UNIQUE(tenantId, shortId) constraint; existing jobs backfilled deterministically
2. Job ID extracted from email subject via regex pattern `[Job ID: ...]` or `[JID: ...]` (case insensitive)
3. IngestionProcessor looks up Job by (shortId, tenantId); sets candidate.jobId atomically
4. No Job ID found → candidate stored with jobId=null; no scoring (skipped entirely)
5. No Job ID in subject → candidate stored with jobId=null; no scoring
6. JobTitleMatcherService completely deleted from codebase (both .ts and .spec.ts files)
7. CandidateExtractSchema has 9 fields (job_title_hint removed); no longer passed to extraction
8. Email ingestion routing is deterministic (regex + DB lookup), not semantic (LLM inference)
9. All tests passing; no TypeScript errors; full test suite green
10. Cost/perf improvement: $0 for routing (was ~$6/month for semantic), 2ms latency (was 500ms+ per LLM call)

**Plans:** 1/1 plans complete

Plans:

- [x] 15-01-PLAN.md — Task 1-8: Extend Job schema with shortId + migration, remove job_title_hint from extraction schema, add regex Job ID extraction to IngestionProcessor, delete JobTitleMatcherService, update seed data, full test verification

### Phase 16: Backend Support for Manual Routing & UI Parity

**Goal:** Enable recruiters to manually assign candidates to jobs—both for unmatched candidates (jobId = null from Phase 15) and for reassigning candidates between jobs. Extend PATCH /candidates/:id endpoint to support job reassignment while preserving full historical audit trail.

**Depends on:** Phase 15

**Requirements:** D-01, D-02, D-03, D-04, D-05, D-06, D-07, D-08, D-09, D-10, D-11, D-12, D-13, D-14, D-15, D-16, D-17, D-18, D-19, D-20, D-21

**Success Criteria** (what must be TRUE):

1. PATCH /candidates/:id endpoint removes ALREADY_ASSIGNED error and allows reassignment (jobId=X→Y)
2. Old Application + scores preserved on reassignment (historical audit trail maintained)
3. New Application created for new job with stage='new' on reassignment
4. Fresh ScoringAgentService.score() call triggered for new job on reassignment
5. hiringStageId always reset to first enabled stage of new job (no stage preservation)
6. Job validation: reassignment rejected with 400 NO_STAGES if job has no enabled stages
7. All updates atomic via Prisma.$transaction (profile fields + job reassignment together)
8. Scoring failure non-blocking: candidate assigned even if score insertion fails (logged as warning)
9. GET /candidates endpoint supports ?unassigned=true filter returning candidates with jobId=null
10. Job responses expose shortId field (used in Phase 15 email subject parsing)
11. Candidate responses expose sourceAgency field (sourcing channel metadata)
12. CandidateResponse DTO remains flattened—NO nested applications array; ai_score calculated via Math.max

**Plans:** 3/3 plans

Plans:

- [ ] 16-01-PLAN.md — Wave 1: Add shortId to JobResponse, verify sourceAgency in CandidateResponse, confirm flattened response format
- [ ] 16-02-PLAN.md — Wave 1: Implement updateCandidate() reassignment logic + findAll() unassigned filter, remove ALREADY_ASSIGNED error
- [ ] 16-03-PLAN.md — Wave 2: Comprehensive integration tests (80+ tests), manual smoke test checkpoint for reassignment workflow

### Phase 17: Production Deployment Readiness: Fix Tests, Add Sanity Checks, and Prepare CI/CD for Hetzner/Jenkins

**Goal:** Close out the v1.0 milestone by hardening the codebase for production: fix all 6 failing tests (Phase 16 regressions), add GET /health endpoint (DB + Redis probes), configure structured JSON logging (nestjs-pino), apply security middleware (helmet, throttler, CORS deny-all), audit all API endpoints against PROTOCOL.md, add Nginx + Let's Encrypt reverse proxy to docker-compose, set container resource limits for Hetzner CX21, create Makefile with 11 developer workflow targets, write Jenkinsfile with parameterized CI pipeline, and rewrite README.md as complete developer onboarding documentation.

**Depends on:** Phase 16

**Requirements:** D-01 to D-38 (from 17-CONTEXT.md)

**Plans:** 5/5 plans complete

Plans:

- [x] 17-01-PLAN.md — Wave 1: Fix 6 failing unit tests (jobs.integration.spec.ts + ingestion.processor.spec.ts)
- [x] 17-02-PLAN.md — Wave 1: Health endpoint (GET /health), E2E smoke test, nestjs-pino structured logging, BullMQ lifecycle logs
- [x] 17-03-PLAN.md — Wave 2: Security hardening (helmet, throttler, CORS deny-all) + API endpoint review vs PROTOCOL.md
- [x] 17-04-PLAN.md — Wave 2: Nginx reverse proxy + Let's Encrypt certbot + docker-compose resource limits + healthcheck
- [x] 17-05-PLAN.md — Wave 3: Makefile (11 targets) + Jenkinsfile (parameterized build) + deploy.sh + README rewrite

## Progress

### v1.0 Phases (Archived)

| Phase                                                           | Plans Complete | Status   | Completed  |
| --------------------------------------------------------------- | -------------- | -------- | ---------- |
| 1. Foundation                                                   | 3/3            | Complete | 2026-03-22 |
| 2. Webhook Intake & Idempotency                                 | 3/3            | Complete | 2026-03-22 |
| 3. Processing Pipeline & Spam Filter                            | 4/4            | Complete | 2026-03-22 |
| 4. AI Extraction                                                | 3/3            | Complete | 2026-03-22 |
| 5. File Storage                                                 | 3/3            | Complete | 2026-03-22 |
| 6. Duplicate Detection                                          | 3/3            | Complete | 2026-03-23 |
| 7. Candidate Storage & Scoring                                  | 2/2            | Complete | 2026-03-23 |
| 8. Phase 1 Verification                                         | 1/1            | Complete | 2026-03-23 |
| 9. Client-facing REST API                                       | 3/3            | Complete | 2026-03-23 |
| 10. Add job creation feature                                    | 4/4            | Complete | 2026-03-24 |
| 11. API Protocol MVP Implementation                             | 1/1            | Complete | 2026-03-25 |
| 12. Support add candidate from the UI                           | 0/1            | Planned  | TBD        |
| 13. Implement Kanban board with candidate hiring stage tracking | 0/1            | Planned  | TBD        |
| 14. Wire OpenRouter extraction pipeline                         | 1/1            | Complete | 2026-03-29 |
| 15. Migrate email ingestion to deterministic Job ID routing     | 1/1            | Complete | 2026-03-31 |
| 16. Backend Support for Manual Routing & UI Parity              | 0/3            | Planned  | TBD        |
| 17. Production Deployment Readiness                             | 5/5            | Complete | 2026-04-01 |

### Phase 20: True Multi-Tenant Isolation — Session-Derived Tenant ID

**Goal:** Replace the hardcoded `TENANT_ID` env var in all business API endpoints with the authenticated user's organization ID extracted from the session JWT. Enforce `SessionGuard` on every business endpoint so unauthenticated callers are rejected and users from Org A can never see data from Org B.

**Depends on:** Phase 19 (SessionGuard + JWT infrastructure)

**Requirements:** TENANT-01 through TENANT-07

**Success Criteria** (what must be TRUE):

1. `GET /candidates`, `POST /candidates`, `GET /candidates/:id`, `PATCH /candidates/:id`, `DELETE /candidates/:id` all require a valid session cookie; unauthenticated requests → 401
2. All candidate service methods receive `tenantId` as an explicit parameter (extracted from `request.session.org`), not from `ConfigService.get('TENANT_ID')`
3. `GET /jobs`, `POST /jobs`, `GET /jobs/:id`, `PUT /jobs/:id`, `DELETE /jobs/:id`, `GET /jobs/list` all require a valid session cookie and use `session.org` for tenant scoping
4. All jobs service methods receive `tenantId` as an explicit parameter
5. `GET /applications` requires a valid session cookie and scopes by `session.org`
6. `GET /config` requires a valid session cookie (config is tenant-agnostic but endpoint must be authenticated)
7. `TENANT_ID` env var made optional in `env.ts` (only used by ingestion worker for email routing; not required for API server)
8. `DedupService` and `IngestionProcessor` continue to use `TENANT_ID` from config (webhook flow has no user session — single-tenant ingestion is an acceptable Phase 1 constraint)
9. All tests updated: service unit tests pass `tenantId` as method param instead of mocking `ConfigService.get('TENANT_ID')`
10. Two users signed in under different orgs each see only their org's candidates and jobs — no cross-tenant data leakage
11. `RESEND_API_KEY` and `RESEND_FROM` env vars added to `env.ts` schema (currently used by `EmailService` but not validated at startup)

**Plans:** 3/3 plans complete

Plans:

- [x] 20-01-PLAN.md — Wave 1: Add `SessionGuard` + `@Req() req` to all business controllers (candidates, jobs, applications, config); extract `tenantId = req.session!.org`; pass to service methods; make `TENANT_ID` optional in env.ts
- [x] 20-02-PLAN.md — Wave 2: Refactor `CandidatesService` and `JobsService` — replace all `configService.get('TENANT_ID')` with tenantId param; update `ApplicationsService` similarly; verify `DedupService`/`IngestionProcessor` still read from config
- [x] 20-03-PLAN.md — Wave 3: Update all affected unit/integration tests; run full test suite; human smoke test (two separate org sign-ins confirm data isolation)

---

### v2.0 Phases

| Phase                                    | Plans Complete | Status   | Started    |
| ---------------------------------------- | -------------- | -------- | ---------- |
| 18. Database Schema & JWT Infrastructure | 1/1            | Complete | 2026-04-09 |
| 19. Auth API Endpoints                   | 4/4            | Complete | 2026-04-11 |
| 20. True Multi-Tenant Isolation          | 3/3 | Complete   | 2026-04-14 |

---

_Roadmap created: 2026-03-22 by /gsd:new-roadmap_
_Updated: 2026-03-31 by plan-phase (Phase 17 planning complete)_
_Updated: 2026-04-07 for v2.0 milestone planning (Phases 18–22, agile structure)_
_Updated: 2026-04-14 by plan-milestone-gaps (Phase 20 added — tenant isolation gap)_
