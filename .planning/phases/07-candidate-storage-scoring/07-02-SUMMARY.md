---
phase: 07-candidate-storage-scoring
plan: "02"
subsystem: pipeline
tags: [bullmq, prisma, scoring, nestjs, tdd, ingestion]

# Dependency graph
requires:
  - phase: 07-01
    provides: ScoringAgentService with ScoringModule exported — used directly by IngestionProcessor
  - phase: 06
    provides: candidateId from dedup phase wired into ProcessingContext — consumed by Phase 7 candidate.update
  - phase: 05
    provides: fileKey from R2 upload stored on ProcessingContext — consumed by Phase 7 cvFileUrl field
  - phase: 04
    provides: CandidateExtract with currentRole, yearsExperience, skills, summary — enrichment fields
provides:
  - "IngestionProcessor.process() complete end-to-end: enrichment + jobs fetch + application upsert + scoring + terminal status"
  - "candidate.update with all 7 enrichment fields (CAND-01)"
  - "job.findMany active jobs fetch with tenantId + status filter (SCOR-01)"
  - "application.upsert per job, idempotent on idx_applications_unique (SCOR-02)"
  - "scoring.service.score() call with error isolation per job (SCOR-03, Issue Fix 2)"
  - "candidateJobScore.create() append-only per job with modelUsed recorded (SCOR-04, SCOR-05)"
  - "emailIntakeLog.update processingStatus=completed as final terminal status (D-16)"
  - "BullMQ lockDuration: 30s on @Processor decorator (Issue Fix 1)"
affects: [phase-08, recruiter-api, pipeline-monitoring]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Error isolation per job in scoring loop: try/catch with continue — one job failure doesn't abort pipeline"
    - "Append-only score inserts: candidateJobScore.create() never upsert — retries create duplicates (acceptable Phase 1)"
    - "Terminal status pattern: processingStatus=completed set only after all Phase 7 work, never mid-pipeline"
    - "Prisma.JsonNull for nullable JSON fields — not plain null"

key-files:
  created: []
  modified:
    - src/ingestion/ingestion.processor.ts
    - src/ingestion/ingestion.module.ts
    - src/ingestion/ingestion.processor.spec.ts
    - src/worker.module.ts

key-decisions:
  - "lockDuration placed on @Processor decorator (not BullMQ.forRootAsync) — lockDuration is WorkerOptions, not QueueOptions (TS2322 would fail)"
  - "Prisma.JsonNull required for metadata field — nullable JSON type in Prisma rejects plain null"
  - "Error isolation per scoring loop iteration: failed job score logged and skipped, pipeline continues"
  - "Append-only score design documented: retries will create duplicate score rows — Phase 2 to add dedup if needed"

patterns-established:
  - "Phase 7 terminal status: emailIntakeLog.update(processingStatus=completed) is the last write in process()"
  - "Scoring error boundary: try/catch around scoringService.score() per job with continue; not around entire loop"

requirements-completed: [CAND-01, CAND-02, CAND-03, SCOR-01, SCOR-02, SCOR-03, SCOR-04, SCOR-05]

# Metrics
duration: 12min
completed: 2026-03-23
---

# Phase 07 Plan 02: Candidate Enrichment + Scoring Pipeline Summary

**End-to-end ingestion pipeline complete: candidate.update with 7 enrichment fields, active jobs fetch, application upsert per job, per-job scoring with error isolation, and terminal processingStatus=completed**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-03-23T09:00:00Z
- **Completed:** 2026-03-23T09:09:26Z
- **Tasks:** 3 (Task 0, Task 1, Task 2 with TDD RED+GREEN)
- **Files modified:** 4

## Accomplishments

- Phase 7 stub in `ingestion.processor.ts` replaced with full implementation: enrichment, jobs fetch, application upsert, scoring with error isolation, terminal status
- ScoringModule wired into IngestionModule; ScoringAgentService injected into IngestionProcessor constructor
- BullMQ worker timeout configured (lockDuration: 30s, lockRenewTime: 5s, maxStalledCount: 2) on @Processor decorator
- 6 new Phase 7 integration tests added (7-02-01 through 7-02-06); all 95 tests pass across 13 suites

## Task Commits

1. **Task 0: BullMQ Worker Timeout** - `8d9b451` (chore)
2. **Task 1: ScoringModule Wiring** - `e820f47` (feat)
3. **Task 2 RED: Failing tests** - `fb61a75` (test)
4. **Task 2 GREEN: Phase 7 Implementation** - `f4701fa` (feat)

## Files Created/Modified

- `src/ingestion/ingestion.processor.ts` — Added Phase 7 block (enrichment + scoring loop + terminal status); @Processor lockDuration; ScoringAgentService constructor injection; Prisma import
- `src/ingestion/ingestion.module.ts` — Added ScoringModule to imports array
- `src/ingestion/ingestion.processor.spec.ts` — Added 6 Phase 7 tests; added ScoringAgentService + Phase 7 prisma mocks to all 3 existing describe blocks; updated AIEX-02 assertion count
- `src/worker.module.ts` — No-op (settings moved to @Processor decorator per deviation)

## Decisions Made

- **BullMQ timeout location:** Plan specified `worker.module.ts` settings block, but `settings` is not on `QueueOptions` (TS2322 error). Moved to `@Processor('ingest-email', { lockDuration: 30000, ... })` — the correct `WorkerOptions` location.
- **Prisma.JsonNull:** `metadata: null` causes TS2322 for nullable JSON fields. Prisma requires `Prisma.JsonNull` sentinel for explicit JSON null. Plan used plain `null`.
- **Test payload spam filter:** Phase 7 `validJobPayload` body was < 100 chars — spam-filtered before Phase 7. Extended to ≥ 100 chars.
- **Existing test updates:** Adding Phase 7 code required updating Phase 5/6 describe blocks to include ScoringAgentService mock + Phase 7 prisma model mocks. AIEX-02 assertion changed from `calledTimes(1)` to `calledTimes(2)` since Phase 7 now calls emailIntakeLog.update with 'completed'.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] BullMQ settings TS2322 — lockDuration belongs on WorkerOptions, not QueueOptions**
- **Found during:** Task 0 (Configure BullMQ Worker Timeout)
- **Issue:** Plan code `settings: { lockDuration, lockRenewTime, maxStalledCount }` inside `BullModule.forRootAsync` useFactory causes `TS2322: Type is not assignable to QueueOptions`. `lockDuration` is defined on `WorkerOptions`, not `QueueOptions`.
- **Fix:** Removed settings block from `worker.module.ts`; added `lockDuration: 30000, lockRenewTime: 5000, maxStalledCount: 2` to the `@Processor('ingest-email', { ... })` decorator in `ingestion.processor.ts`
- **Files modified:** src/worker.module.ts (reverted), src/ingestion/ingestion.processor.ts (decorator)
- **Verification:** `npx tsc --noEmit` exits 0
- **Committed in:** 8d9b451

**2. [Rule 1 - Bug] Prisma.JsonNull required for nullable JSON metadata field**
- **Found during:** Task 2 (Phase 7 implementation)
- **Issue:** `metadata: null` caused TS2322 — Prisma nullable JSON fields require `Prisma.JsonNull` sentinel
- **Fix:** Added `import { Prisma } from '@prisma/client'` and used `metadata: Prisma.JsonNull`; also required `npx prisma generate` as generated client was missing `aiSummary` field (schema/client out of sync)
- **Files modified:** src/ingestion/ingestion.processor.ts, src/ingestion/ingestion.processor.spec.ts
- **Verification:** `npx tsc --noEmit` exits 0
- **Committed in:** f4701fa

**3. [Rule 1 - Bug] Existing describe blocks broke after constructor update**
- **Found during:** Task 2 (Phase 7 integration tests)
- **Issue:** Adding `ScoringAgentService` to IngestionProcessor constructor broke all 3 existing describe blocks (NestJS DI resolution error). Additionally, Phase 7 code running through Phase 7 broke Phase 6 test assertion `emailIntakeLog.update.calledTimes(1)`.
- **Fix:** Added `ScoringAgentService` mock + Phase 7 prisma model mocks to all existing describe blocks; updated AIEX-02 assertion to `calledTimes(2)`. Fixed `validJobPayload` TextBody to pass spam filter (< 100 chars was rejected before Phase 7).
- **Files modified:** src/ingestion/ingestion.processor.spec.ts
- **Verification:** `npx jest --no-coverage` exits 0, 95/95 tests passing
- **Committed in:** f4701fa

---

**Total deviations:** 3 auto-fixed (all Rule 1 bugs)
**Impact on plan:** All auto-fixes necessary for correctness. lockDuration correctly placed per BullMQ API. Prisma.JsonNull required by type system. No scope creep.

## Issues Encountered

- Prisma client was out of sync with schema (missing `aiSummary` field in generated types). Ran `npx prisma generate` to resolve — TypeScript immediately clean.

## Known Stubs

- `scoringService.score()` returns hardcoded mock result (score: 72) — real Anthropic Sonnet call is commented out in `scoring.service.ts` with TODO comment. This is intentional for Phase 1 offline testing; real API activation is a future task.

## Next Phase Readiness

- End-to-end pipeline is complete: email in → scored candidate record out
- All 8 requirements CAND-01 through SCOR-05 addressed
- All 4 identified issues fixed (timeout, error isolation, duplicate scores documented, partial index verified)
- Pipeline ready for real Anthropic API activation (ExtractionAgentService + ScoringAgentService both have TODOs for real calls)
- Phase 2 (recruiter API) can begin — data model is fully populated

## Self-Check: PASSED

- FOUND: .planning/phases/07-candidate-storage-scoring/07-02-SUMMARY.md
- FOUND: src/ingestion/ingestion.processor.ts
- FOUND: src/ingestion/ingestion.module.ts
- FOUND: 8d9b451 (Task 0 commit)
- FOUND: e820f47 (Task 1 commit)
- FOUND: fb61a75 (Task 2 RED commit)
- FOUND: f4701fa (Task 2 GREEN commit)
- 95/95 tests passing, TypeScript clean

---
*Phase: 07-candidate-storage-scoring*
*Completed: 2026-03-23*
