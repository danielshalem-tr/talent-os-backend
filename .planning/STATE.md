---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Milestone
status: Ready to execute
last_updated: "2026-04-14T05:41:31.641Z"
last_activity: 2026-04-14
progress:
  total_phases: 20
  completed_phases: 18
  total_plans: 49
  completed_plans: 48
  percent: 98
---

# State: Triolla Talent OS — Backend

**Initialized (v1.0):** 2026-03-22 at 00:00 UTC
**Restarted (v2.0):** 2026-04-07 at 00:00 UTC
**Model:** Claude Haiku 4.5
**Budget:** 200,000 tokens

## Project Reference

**v1.0 Core Value (Complete):** Inbound CVs are automatically processed, de-duplicated, and scored against open jobs without any manual recruiter effort — end-to-end from email receipt to scored candidate record.

**v2.0 Core Value (Planning):** Organization-level signup, admin-managed user accounts, and role-based recruiter access to the platform.

**Tech Stack (Locked):** TypeScript, NestJS 11, BullMQ + Redis, Prisma 7, PostgreSQL 16, OpenRouter via @openrouter/sdk (openai/gpt-4o-mini), Cloudflare R2, Postmark Inbound webhooks.

## Current Position

Milestone: v2.0 (5 phases planned, agile structure)
Phase: 20 (tenant-isolation) — EXECUTING
Plan: 3 of 3

**STATUS: v1.0 complete (17 phases, 250+ tests). v2.0 planning done. Ready to execute Phase 18.**

## Accumulated Context

### Decisions Locked (Phase 1 scope)

1. **Database Schema First**: All 7 tables with tenant_id, indexes, constraints created in Prisma migration before webhook endpoint
2. **Separate API + Worker**: NestJS HTTP only, separate BullMQ worker process — never block webhook receipt
3. **Environment Validation at Startup**: @nestjs/config + Zod — fail fast on missing vars, don't deploy broken config
4. **No In-Memory Dedup**: pg_trgm extension, not vector DB or Elasticsearch — scales naturally, zero infra
5. **Append-Only Scores**: candidate_job_scores never updated, always appended — full history preserved
6. **Fuzzy Match → Human Review**: Never auto-upsert on fuzzy match — dual-name confusion is data corruption, flag for human

### Research Completed

- Full architecture spec approved 2026-03-19: `spec/backend-architecture-proposal.md`
- Postmark inbound webhook auth method confirmed
- pg_trgm performance validated at 500 CVs/month scale
- Cost model: ~€5/month Hetzner + ~$6–16/month OpenRouter (openai/gpt-4o-mini)

### Open Questions (Phase 2+)

- Recruiter auth solution (JWT vs Clerk vs other)
- Outbound email provider for candidate outreach
- Voice screening approach (Twilio vs Elevenlabs vs other)
- Monitoring tooling (Sentry + BullMQ dashboard recommended but not blocking)

### Roadmap Evolution

- Phase 9 added: Create client-facing REST API endpoints
- Phase 10 added: Add job creation feature
- Phase 11 added: Review and validate API protocol MVP spec and implementation guide
- Phase 12 discovered: Support add candidate from the UI (already planned)
- Phase 13 added: Implement Kanban board with candidate hiring stage tracking
- Phase 14 added: Wire OpenRouter extraction pipeline: email→LLM→dedup→scoring→UI
- Phase 15 added: Migrate email ingestion to deterministic Job ID routing and remove semantic matching
- Phase 16 added: Backend Support for Manual Routing & UI Parity
- Phase 17 added: Production Deployment Readiness: Fix Tests, Add Sanity Checks, and Prepare CI/CD for Hetzner/Jenkins
- Phase 19 re-scoped (2026-04-11): Old scope (bcrypt signup endpoint) superseded by frontend-driven Protocol.md section 7 contract. New scope: all Auth API endpoints — Google OAuth, magic link, invitation flow, session cookies, team management

### Blockers

None — ready to proceed to `/gsd:plan-phase 1`.

### Quick Tasks Completed

| #          | Description                                                                                                                                                             | Date       | Commit  | Directory                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 260322-kkx | Upgrade Prisma from 6 to 7                                                                                                                                              | 2026-03-22 | 4cfe9dc | [260322-kkx-upgrade-prisma-from-6-to-7](./quick/260322-kkx-upgrade-prisma-from-6-to-7/)                                           |
| 260322-lsq | Fix env and docker-compose inconsistency (prisma.config.ts root + docker env vars)                                                                                      | 2026-03-22 | a457e50 | [260322-lsq-fix-env-and-docker-compose-inconsistency](./quick/260322-lsq-fix-env-and-docker-compose-inconsistency/)               |
| 260322-qd4 | commit untracked phase context files                                                                                                                                    | 2026-03-22 | 9678b11 | [260322-qd4-commit-untracked-phase-context-files](./quick/260322-qd4-commit-untracked-phase-context-files/)                       |
| 260322-qxt | Update STATE.md narrative to accurately reflect all completed phases (01-04) and current position                                                                       | 2026-03-22 | 601e3b7 | [260322-qxt-update-state-md-narrative-to-accurately-](./quick/260322-qxt-update-state-md-narrative-to-accurately-/)               |
| 260322-scj | Update STATE.md to reflect Phase 5 completion and Phase 6 readiness                                                                                                     | 2026-03-22 | 3c54976 | [260322-scj-update-state-md-and-requirements-md-to-r](./quick/260322-scj-update-state-md-and-requirements-md-to-r/)               |
| 260322-uov | Fix 3 critical bugs: CV loss, BullMQ retry, race condition duplicate                                                                                                    | 2026-03-22 | 4b89bf4 | [260322-uov-fix-3-critical-bugs-in-implemented-phase](./quick/260322-uov-fix-3-critical-bugs-in-implemented-phase/)               |
| 260323-d4s | Fix Phase 6 bugs: pg_trgm % operator (wrong threshold), inverted name miss, non-atomic DB writes                                                                        | 2026-03-23 | 6a9d372 | [260323-d4s-investigate-and-fix-4-reported-phase-6-i](./quick/260323-d4s-investigate-and-fix-4-reported-phase-6-i/)               |
| 260323-dhl | Commit untracked PLAN.md from 260323-d4s quick task                                                                                                                     | 2026-03-23 | e5284a2 | [260323-dhl-commit-the-unsaved-changes-from-the-last](./quick/260323-dhl-commit-the-unsaved-changes-from-the-last/)               |
| 260323-e60 | Fix TS2454: definite assignment assertion on candidateId in ingestion.processor.ts                                                                                      | 2026-03-23 | 12c5ed0 | [260323-e60-fix-ts2454-candidateid-used-before-assig](./quick/260323-e60-fix-ts2454-candidateid-used-before-assig/)               |
| 260323-jll | Developer onboarding: docker-compose.dev.yml, db:setup npm script, Israel timezone logging, ngrok helper, Getting Started README                                        | 2026-03-23 | 15af143 | [260323-jll-developer-onboarding-docker-watch-script](./quick/260323-jll-developer-onboarding-docker-watch-script/)               |
| 260323-mai | Validate uncommitted changes; fix ngrok token parsing bug (cut -f2-); 4 atomic commits                                                                                  | 2026-03-23 | 8b4a1fc | [260323-mai-validate-uncommitted-changes-find-potent](./quick/260323-mai-validate-uncommitted-changes-find-potent/)               |
| 260324-agv | Replace Mock AI Extraction with OpenRouter MVP                                                                                                                          | 2026-03-24 | 1d93b1b | [260324-agv-replace-mock-ai-extraction-with-openrout](./quick/260324-agv-replace-mock-ai-extraction-with-openrout/)               |
| 260324-c3g | Clean up ExtractionAgentService: remove ENABLE_AI_EXTRACTION flag, isolate callAI(), add 2 seed candidates                                                              | 2026-03-24 | 80645f8 | [260324-c3g-clean-up-extraction-agent-service-ts-for](./quick/260324-c3g-clean-up-extraction-agent-service-ts-for/)               |
| 260324-cbs | Commit unstaged changes: @openrouter/sdk swap, CandidateExtract snake_case field rename, Zod v4 fix, PROTOCOL.md                                                        | 2026-03-24 | a5c32c7 | [260324-cbs-commit-all-unsaved-changes-into-atomic-c](./quick/260324-cbs-commit-all-unsaved-changes-into-atomic-c/)               |
| 260324-dvq | Fix hiringStages guard in 10-02-PLAN.md: empty array [] now falls through to default seeding                                                                            | 2026-03-24 | bc1cc8a | [260324-dvq-fix-seeding-loophole-in-plan-10-02-hirin](./quick/260324-dvq-fix-seeding-loophole-in-plan-10-02-hirin/)               |
| 260329-dot | Atomic commit of 9 pending file changes — consolidate phase 14 planning artifacts and replace superseded spec files                                                     | 2026-03-29 | fa4667f | [260329-dot-make-atomic-commit-of-9-pending-file-cha](./quick/260329-dot-make-atomic-commit-of-9-pending-file-cha/)               |
| 260329-kxa | Refactor AI scoring to only execute on successful candidate-job match                                                                                                   | 2026-03-29 | e001d89 | [260329-kxa-refactor-ai-scoring-to-only-execute-on-s](./quick/260329-kxa-refactor-ai-scoring-to-only-execute-on-s/)               |
| 260329-lpo | Simplify prisma/seed.ts with 3 jobs, 1 candidate, remove --tenant-only option                                                                                           | 2026-03-29 | a16eee9 | [260329-lpo-simplify-prisma-seed-ts-with-3-jobs-1-ca](./quick/260329-lpo-simplify-prisma-seed-ts-with-3-jobs-1-ca/)               |
| 260329-m36 | Fix seed.ts: add DEFAULT_HIRING_STAGES to jobs when creating them                                                                                                       | 2026-03-29 | 96d66e1 | [260329-m36-fix-seed-ts-add-default-hiring-stages-to](./quick/260329-m36-fix-seed-ts-add-default-hiring-stages-to/)               |
| 260329-mpw | Product requirement update for Phase 6.5 (Job Matching): Replace Levenshtein distance with semantic matching                                                            | 2026-03-29 | 38a5962 | [260329-mpw-product-requirement-update-for-phase-6-5](./quick/260329-mpw-product-requirement-update-for-phase-6-5/)               |
| 260329-n58 | Fix ScoringAgentService test error + swap to @openrouter/sdk                                                                                                            | 2026-03-29 | a655ab3 | [260329-n58-fix-scoringagentservice-test-error-swap-](./quick/260329-n58-fix-scoringagentservice-test-error-swap-openrouter-sdk/) |
| 260329-ndq | Wire JobTitleMatcherService into IngestionProcessor Phase 6.5, replace Levenshtein with semantic matching                                                               | 2026-03-29 | 6d2e39a | [260329-ndq-wire-jobtitlematcherservice-into-ingesti](./quick/260329-ndq-wire-jobtitlematcherservice-into-ingesti/)               |
| 260330-gyd | Add GET /candidates/:id endpoint to fetch a single candidate by ID                                                                                                      | 2026-03-30 | 13a8ec6 | [260330-gyd-add-get-candidates-id-endpoint-to-fetch-](./quick/260330-gyd-add-get-candidates-id-endpoint-to-fetch-/)               |
| 260330-idw | Add GET /jobs/:id endpoint to fetch single job with hiring_flow and screening_questions                                                                                 | 2026-03-30 | fcf3bae | [260330-idw-add-get-jobs-id-endpoint-to-fetch-single](./quick/260330-idw-add-get-jobs-id-endpoint-to-fetch-single/)               |
| 260401-c3k | Remove Jenkins, add GitHub Actions CI, strip nginx/certbot from docker-compose                                                                                          | 2026-04-01 | 212186d | [260401-c3k-remove-jenkins-add-github-actions-ci-upd](./quick/260401-c3k-remove-jenkins-add-github-actions-ci-upd/)               |
| 260401-ccr | Clean up Coolify migration leftovers: delete nginx.conf, deploy.sh, setup-ssl.sh; remove Makefile targets; fix CI node-version to 22                                    | 2026-04-01 | a0ca032 | [260401-ccr-clean-up-coolify-migration-leftovers-del](./quick/260401-ccr-clean-up-coolify-migration-leftovers-del/)               |
| 260406-85x | Clean up and update planning docs: fix tech stack refs (OpenRouter, Prisma 7), mark Phases 16–17 complete, sync REQUIREMENTS.md model names                             | 2026-04-06 | 13895b6 | [260406-85x-clean-up-and-update-the-planning-directo](./quick/260406-85x-clean-up-and-update-the-planning-directo/)               |
| 260407-hys | Refactor deduplication logic: replace email + fuzzy-name dedup with phone-exact-match; phone_missing sentinel for HR review queue                                       | 2026-04-07 | 5b80a6c | [260407-hys-refactor-the-deduplication-logic-in-src-](./quick/260407-hys-refactor-the-deduplication-logic-in-src-/)               |
| 260407-iff | Ensure phone number normalization treats international prefixes (+972) and local leading zeros (0) as identical matches; record duplicates in flags table for HR review | 2026-04-07 | 4502a79 | [260407-iff-ensure-phone-number-normalization-by-tre](./quick/260407-iff-ensure-phone-number-normalization-by-tre/)               |
| 260412-9rb | Replace nodemailer/SMTP with Resend SDK in EmailService; add RESEND_API_KEY/RESEND_FROM env vars; same dev-fallback pattern preserved                                  | 2026-04-12 | fa20d7a | [260412-9rb-use-resend-instead-of-nodemailer-smtp-fo](./quick/260412-9rb-use-resend-instead-of-nodemailer-smtp-fo/)               |

### Todos

- [ ] Deploy to Hetzner VPS (post-Phase 7)

## Session Continuity

**Last Session:** 2026-04-14T05:41:24.315Z
Last activity: 2026-04-14

**Phase 16 & 17 Complete:**

16. Phase 16 (Backend Support for Manual Routing & UI Parity) — COMPLETE ✓
    - PATCH /candidates/:id supports job reassignment (preserves old Application + scores, creates new Application, rescores)
    - GET /candidates supports ?unassigned=true filter
    - GET /jobs and GET /jobs/:id expose shortId field
    - GET /candidates exposes sourceAgency field
    - Features verified in codebase 2026-04-06 (implemented without plan-tracking)
    - 250 tests passing

17. Phase 17 (Production Deployment Readiness) — COMPLETE ✓
    - GET /health endpoint (DB + Redis probes)
    - nestjs-pino structured JSON logging
    - Security: helmet, throttler, CORS deny-all
    - GitHub Actions CI pipeline
    - docker-compose resource limits and healthchecks
    - README rewritten as developer onboarding docs

**Previous Session (Phase 15):**

11. Phase 11 (API Protocol MVP Implementation) — COMPLETE ✓
    - 11-01: Full jobs API with GET /config, GET/POST/PUT/DELETE /jobs endpoints
    - Schema extended: JobStage (interviewer, is_enabled, color), ScreeningQuestion (expected_answer)
    - AppConfigModule with hardcoded 6 lookup tables and 4-stage template
    - JobsService: findAll() with nested data, createJob() with default stage seeding, updateJob() atomic delete-recreate, deleteJob() soft-delete
    - JobsController: all 5 endpoints with standard error format, validation, tenant isolation
    - CreateJobDto: snake_case fields, cross-field validation (at least one stage enabled)
    - 195 tests passing across 19 test suites (39 new integration tests)
    - Verification: human checkpoint approved for API response format and behavior
    - 1 deviation auto-fixed: color field added to schema (spec-required, not client-computed)

**Full Phase Completion:**

1. Phase 01 (Foundation) — all 3 plans complete ✓
   - 01-01: NestJS bootstrap + BullMQ worker entry point
   - 01-02: Prisma schema (7 tables), migration, pg_trgm indexes, seed data
   - 01-03: Multi-stage Dockerfile + docker-compose.yml (4 services, health checks) — human checkpoint passed
2. Quick tasks: Prisma 6→7 upgrade (260322-kkx), env/docker-compose fix (260322-lsq)
3. Phase 02 (Webhook Intake & Idempotency) — all 3 plans complete ✓
   - 02-01: PostmarkPayloadDto (Zod), test scaffolds, IngestionProcessor stub
   - 02-02: PostmarkAuthGuard (Basic Auth), WebhooksService (idempotency + enqueue), WebhooksController
   - 02-03: Wire WebhooksModule + IngestionModule into root modules; human smoke test passed (all 8 checks)
   - Auto-fix applied: Dockerfile CMD path + UUID validation corrected during Docker startup verification
4. Phase 03 (Processing Pipeline & Spam Filter) — all 4 plans complete ✓
   - 03-00: 3 test spec stub files created (spam-filter, attachment-extractor, processor integration)
   - 03-01: SpamFilterService with 5 passing unit tests (PROC-02, PROC-03)
   - 03-02: AttachmentExtractorService (pdf-parse + mammoth) with 5 passing unit tests (PROC-04, PROC-05)
   - 03-03: Fixed Phase 2 blob-stripping bug; wired full IngestionProcessor pipeline; 2 integration tests (PROC-06)
   - 22 total tests passing across 3 suites after Phase 03
5. Phase 04 (AI Extraction) — all 3 plans complete ✓
   - 04-00: extraction-agent.service.spec.ts stub + minimal service stub created
   - 04-01: ExtractionAgentService (deterministic mock) with CandidateExtractSchema (Zod) + 5 unit tests (AIEX-01, AIEX-02, AIEX-03)
   - 04-02: ExtractionAgentService wired into IngestionProcessor + IngestionModule; 2 integration tests; 34 total tests passing
   - Note: ExtractionAgentService.extract() is a deterministic mock returning hardcoded 'Jane Doe' — real Anthropic Haiku call pending Phase 5 or follow-up
6. Phase 05 (File Storage) — all 3 plans complete ✓
   - 05-00: StorageService stub, StorageModule, and failing test scaffolds created (Nyquist setup)
   - 05-01: StorageService (S3Client, PutObjectCommand, attachment selection, R2 key generation) with 5 unit tests (STOR-01, STOR-02, D-07, D-11)
   - 05-02: StorageService wired into IngestionProcessor via constructor injection; ProcessingContext extended with fileKey (string|null) and cvText fields; IngestionModule imports StorageModule; 3 integration tests (5-02-01, 5-02-02, 5-02-03) — 70 total tests passing across 11 suites
   - Verification: 6/6 must-haves verified — PASSED
   - Note: ExtractionAgentService.extract() remains a deterministic mock (TODO in Phase 4 code) — real Anthropic Haiku call still pending; does not block Phase 6

7. Quick task 260322-uov — 3 critical bugs fixed in ingestion pipeline ✓
   - BUG-CV-LOSS: storageService.upload() moved before extractionAgent.extract() — CV now persisted even on AI failure
   - BUG-RETRY: Changed `return` to `throw err` in extraction catch — BullMQ now retries on transient failures
   - BUG-RACE: Added jobId: messageId to both queue.add() calls + P2002 try/catch in prisma.create — concurrent duplicates handled gracefully
   - 75 tests passing (5 new tests added), 11 suites, 0 failures

8. Quick task 260323-d4s — Phase 6 bug fixes (pg_trgm + atomicity) ✓
   - Fixed pg_trgm % operator replaced with similarity() > 0.7 in SQL WHERE — threshold now enforced in SQL not app layer
   - Added GREATEST(similarity(name), similarity(reversedName)) — inverted tokens (Smith John vs John Smith) now match
   - Wrapped Phase 6 DB block in prisma.$transaction — candidate INSERT + flag + intake log update are atomic
   - Added tx? param to DedupService.insertCandidate, upsertCandidate, createFlag — defaults to this.prisma
   - 86 tests passing (3 new: DEDUP-06, DEDUP-07, atomicity test), 12 suites, 0 failures

9. Phases 07-11 (Parallel Implementation Waves)
   - Phase 07 (Candidate Scoring): scoring_agent.service.ts, ScoringModule, 48 tests
   - Phase 08 (Email Intake Log): intake_logs table, EnqueueHandler logging, 102 total tests
   - Phase 09 (REST API): JobsController, GET /jobs, POST /jobs, validation, 145 total tests
   - Phase 10 (Job Creation): POST /jobs enhancement, default stage seeding, 145 tests
   - Phase 11 (API Protocol MVP): Full job management API, schema updates, 195 tests

10. Phase 12 (Add Candidate from UI) — COMPLETE ✓
    - POST /candidates endpoint with multipart form upload to R2
    - Manual candidate creation flow (outside email pipeline)

11. Phase 13 (Kanban Board Candidate Hiring Stage Tracking) — COMPLETE ✓
    - Application stage transitions (new → screening → interview → offer → hired/rejected)
    - Stage history tracking

12. Phase 14 (OpenRouter Extraction Pipeline) — COMPLETE ✓
    - Real LLM calls replacing mock extraction — @openrouter/sdk + openai/gpt-4o-mini
    - Email → LLM → dedup → scoring → UI pipeline fully live
    - Quick tasks: 260324-agv (OpenRouter MVP), 260324-c3g (cleanup), 260324-cbs (SDK swap)

13. Phase 15 (Deterministic Job ID Routing) — COMPLETE ✓
    - Regex + shortId lookup replacing semantic matching (Levenshtein/embedding)
    - Removed JobTitleMatcherService semantic layer
    - Quick task: 260329-ndq (deterministic routing wire-up)

14. Phase 16 (Backend Support for Manual Routing & UI Parity) — COMPLETE ✓
    - PATCH /candidates/:id supports job reassignment (preserves old Application + scores, creates new Application, rescores)
    - GET /candidates supports ?unassigned=true filter
    - GET /jobs and GET /jobs/:id expose shortId field
    - GET /candidates exposes sourceAgency field
    - 250 tests passing

15. Phase 17 (Production Deployment Readiness) — COMPLETE ✓
    - GET /health endpoint (DB + Redis probes)
    - nestjs-pino structured JSON logging
    - Security: helmet, throttler, CORS deny-all
    - GitHub Actions CI pipeline (quick task 260401-c3k)
    - docker-compose resource limits and healthchecks
    - README rewritten as developer onboarding docs

**Next Step:**
All 17 phases complete. v1.0 milestone done. Ready for:

- Deployment to Hetzner VPS
- Phase 2 planning (recruiter auth, admin UI, outbound communications)

---

_State initialized: 2026-03-22 at 00:00 UTC_
