---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: Milestone complete
last_updated: "2026-03-25T08:18:25.735Z"
last_activity: 2026-03-25
progress:
  total_phases: 11
  completed_phases: 11
  total_plans: 30
  completed_plans: 30
---

# State: Triolla Talent OS — Backend

**Initialized:** 2026-03-22 at 00:00 UTC
**Model:** Claude Haiku 4.5
**Budget:** 200,000 tokens

## Project Reference

**Core Value:** Inbound CVs are automatically processed, de-duplicated, and scored against open jobs without any manual recruiter effort — end-to-end from email receipt to scored candidate record.

**Current Focus:** Phase 11 — review-and-validate-api-protocol-mvp-spec-and-implementation-guide

**Tech Stack (Locked):** TypeScript, NestJS 11, BullMQ + Redis, Prisma 7, PostgreSQL 16, Vercel AI SDK, Claude Haiku + Sonnet, Cloudflare R2, Postmark Inbound webhooks.

## Current Position

Phase: 11
Plan: Not started

**STATUS: All planned phases and plans complete. Ready for deployment and Phase 2 planning.**

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
- Cost model: ~€5/month Hetzner + ~$6–16/month Anthropic

### Open Questions (Phase 2+)

- Recruiter auth solution (JWT vs Clerk vs other)
- Outbound email provider for candidate outreach
- Voice screening approach (Twilio vs Elevenlabs vs other)
- Monitoring tooling (Sentry + BullMQ dashboard recommended but not blocking)

### Roadmap Evolution

- Phase 9 added: Create client-facing REST API endpoints
- Phase 10 added: Add job creation feature
- Phase 11 added: Review and validate API protocol MVP spec and implementation guide

### Blockers

None — ready to proceed to `/gsd:plan-phase 1`.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260322-kkx | Upgrade Prisma from 6 to 7 | 2026-03-22 | 4cfe9dc | [260322-kkx-upgrade-prisma-from-6-to-7](./quick/260322-kkx-upgrade-prisma-from-6-to-7/) |
| 260322-lsq | Fix env and docker-compose inconsistency (prisma.config.ts root + docker env vars) | 2026-03-22 | a457e50 | [260322-lsq-fix-env-and-docker-compose-inconsistency](./quick/260322-lsq-fix-env-and-docker-compose-inconsistency/) |
| 260322-qd4 | commit untracked phase context files | 2026-03-22 | 9678b11 | [260322-qd4-commit-untracked-phase-context-files](./quick/260322-qd4-commit-untracked-phase-context-files/) |
| 260322-qxt | Update STATE.md narrative to accurately reflect all completed phases (01-04) and current position | 2026-03-22 | 601e3b7 | [260322-qxt-update-state-md-narrative-to-accurately-](./quick/260322-qxt-update-state-md-narrative-to-accurately-/) |
| 260322-scj | Update STATE.md to reflect Phase 5 completion and Phase 6 readiness | 2026-03-22 | 3c54976 | [260322-scj-update-state-md-and-requirements-md-to-r](./quick/260322-scj-update-state-md-and-requirements-md-to-r/) |
| 260322-uov | Fix 3 critical bugs: CV loss, BullMQ retry, race condition duplicate | 2026-03-22 | 4b89bf4 | [260322-uov-fix-3-critical-bugs-in-implemented-phase](./quick/260322-uov-fix-3-critical-bugs-in-implemented-phase/) |
| 260323-d4s | Fix Phase 6 bugs: pg_trgm % operator (wrong threshold), inverted name miss, non-atomic DB writes | 2026-03-23 | 6a9d372 | [260323-d4s-investigate-and-fix-4-reported-phase-6-i](./quick/260323-d4s-investigate-and-fix-4-reported-phase-6-i/) |
| 260323-dhl | Commit untracked PLAN.md from 260323-d4s quick task | 2026-03-23 | e5284a2 | [260323-dhl-commit-the-unsaved-changes-from-the-last](./quick/260323-dhl-commit-the-unsaved-changes-from-the-last/) |
| 260323-e60 | Fix TS2454: definite assignment assertion on candidateId in ingestion.processor.ts | 2026-03-23 | 12c5ed0 | [260323-e60-fix-ts2454-candidateid-used-before-assig](./quick/260323-e60-fix-ts2454-candidateid-used-before-assig/) |
| 260323-jll | Developer onboarding: docker-compose.dev.yml, db:setup npm script, Israel timezone logging, ngrok helper, Getting Started README | 2026-03-23 | 15af143 | [260323-jll-developer-onboarding-docker-watch-script](./quick/260323-jll-developer-onboarding-docker-watch-script/) |
| 260323-mai | Validate uncommitted changes; fix ngrok token parsing bug (cut -f2-); 4 atomic commits | 2026-03-23 | 8b4a1fc | [260323-mai-validate-uncommitted-changes-find-potent](./quick/260323-mai-validate-uncommitted-changes-find-potent/) |
| 260324-agv | Replace Mock AI Extraction with OpenRouter MVP | 2026-03-24 | 1d93b1b | [260324-agv-replace-mock-ai-extraction-with-openrout](./quick/260324-agv-replace-mock-ai-extraction-with-openrout/) |
| 260324-c3g | Clean up ExtractionAgentService: remove ENABLE_AI_EXTRACTION flag, isolate callAI(), add 2 seed candidates | 2026-03-24 | 80645f8 | [260324-c3g-clean-up-extraction-agent-service-ts-for](./quick/260324-c3g-clean-up-extraction-agent-service-ts-for/) |
| 260324-cbs | Commit unstaged changes: @openrouter/sdk swap, CandidateExtract snake_case field rename, Zod v4 fix, PROTOCOL.md | 2026-03-24 | a5c32c7 | [260324-cbs-commit-all-unsaved-changes-into-atomic-c](./quick/260324-cbs-commit-all-unsaved-changes-into-atomic-c/) |
| 260324-dvq | Fix hiringStages guard in 10-02-PLAN.md: empty array [] now falls through to default seeding | 2026-03-24 | bc1cc8a | [260324-dvq-fix-seeding-loophole-in-plan-10-02-hirin](./quick/260324-dvq-fix-seeding-loophole-in-plan-10-02-hirin/) |
| 260326-dyi | Add optional status query param to GET /jobs endpoint | 2026-03-26 | 0b033fd | [260326-dyi-add-status-query-param-to-jobs-endpoint](./quick/260326-dyi-add-status-query-param-to-jobs-endpoint/) |

### Todos

- [ ] Deploy to Hetzner VPS (post-Phase 7)

## Session Continuity

**Last Session:** 2026-03-26T10:00:00.000Z
Last activity: 2026-03-26

**What Happened (Phase 11 Final):**

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
5. Phase 05 (File Storage) — all 3 plans complete ✓
   - 05-00: StorageService stub, StorageModule, and failing test scaffolds created (Nyquist setup)
   - 05-01: StorageService (S3Client, PutObjectCommand, attachment selection, R2 key generation) with 5 unit tests (STOR-01, STOR-02, D-07, D-11)
   - 05-02: StorageService wired into IngestionProcessor via constructor injection; ProcessingContext extended with fileKey (string|null) and cvText fields; IngestionModule imports StorageModule; 3 integration tests (5-02-01, 5-02-02, 5-02-03) — 70 total tests passing across 11 suites
   - Verification: 6/6 must-haves verified — PASSED
   - Note: ExtractionAgentService.extract() remains a deterministic mock (TODO in Phase 4 code) — real Anthropic Haiku call still pending; does not block Phase 6

6. Quick task 260322-uov — 3 critical bugs fixed in ingestion pipeline ✓
   - BUG-CV-LOSS: storageService.upload() moved before extractionAgent.extract() — CV now persisted even on AI failure
   - BUG-RETRY: Changed `return` to `throw err` in extraction catch — BullMQ now retries on transient failures
   - BUG-RACE: Added jobId: messageId to both queue.add() calls + P2002 try/catch in prisma.create — concurrent duplicates handled gracefully
   - 75 tests passing (5 new tests added), 11 suites, 0 failures

7. Quick task 260323-d4s — Phase 6 bug fixes (pg_trgm + atomicity) ✓
   - Fixed pg_trgm % operator replaced with similarity() > 0.7 in SQL WHERE — threshold now enforced in SQL not app layer
   - Added GREATEST(similarity(name), similarity(reversedName)) — inverted tokens (Smith John vs John Smith) now match
   - Wrapped Phase 6 DB block in prisma.$transaction — candidate INSERT + flag + intake log update are atomic
   - Added tx? param to DedupService.insertCandidate, upsertCandidate, createFlag — defaults to this.prisma
   - 86 tests passing (3 new: DEDUP-06, DEDUP-07, atomicity test), 12 suites, 0 failures

8. Phases 07-11 (Parallel Implementation Waves)
   - Phase 07 (Candidate Scoring): scoring_agent.service.ts, ScoringModule, 48 tests
   - Phase 08 (Email Intake Log): intake_logs table, EnqueueHandler logging, 102 total tests
   - Phase 09 (REST API): JobsController, GET /jobs, POST /jobs, validation, 145 total tests
   - Phase 10 (Job Creation): POST /jobs enhancement, default stage seeding, 145 tests
   - Phase 11 (API Protocol MVP): Full job management API, schema updates, 195 tests

**Next Step:**
All Phase 1 MVP work complete. Ready for:

- Deployment to Hetzner VPS
- Phase 2 planning (recruiter auth, admin UI, outbound communications)

---

*State initialized: 2026-03-22 at 00:00 UTC*
