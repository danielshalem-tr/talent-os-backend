---
phase: 14-wire-openrouter-extraction-pipeline-email-llm-dedup-scoring-ui
plan: 01
subsystem: api
tags: [openrouter, zod, nestjs, extraction, llm, bullmq]

# Dependency graph
requires:
  - phase: 04-ai-extraction
    provides: ExtractionAgentService with CandidateExtractSchema (5 fields) and mock extract()
provides:
  - CandidateExtractSchema extended to 10 fields (full_name, email, phone, current_role, years_experience, location, job_title_hint, skills, ai_summary, source_hint)
  - extract() method signature with metadata parameter (subject, fromEmail) — errors propagate to BullMQ
  - extractDeterministically() made public — ready for fallback use in processor
  - Updated INSTRUCTIONS prompt with field constraints, few-shot example, and source detection signals
  - Test helpers (mockCandidateExtract, mockCandidateDedupExtract) with all 10 fields
affects: [14-02, 14-03, ingestion.processor, dedup.service, scoring]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "safeParse() over .parse() for explicit LLM output validation — returns error object instead of throwing"
    - "Error propagation without try/catch in service layer — orchestrator (processor) handles retry logic"
    - "Email metadata prepended to LLM user message for source detection signals"

key-files:
  created: []
  modified:
    - src/ingestion/services/extraction-agent.service.ts
    - src/ingestion/services/extraction-agent.service.spec.ts
    - src/ingestion/services/extraction-agent.service.test-helpers.ts
    - src/dedup/dedup.service.spec.ts
    - src/ingestion/ingestion.processor.spec.ts

key-decisions:
  - "Remove try/catch from extract() — let errors propagate to processor/BullMQ for retry (not swallow-and-fallback)"
  - "Use safeParse() not .parse() in callAI() for intentional error handling over implicit exception throwing"
  - "10 fields in schema: added current_role, years_experience, location, job_title_hint, source_hint"
  - "extractDeterministically() made public so processor can call it as final-attempt fallback"

patterns-established:
  - "LLM service: throw on failure, caller orchestrates retry — not swallow-and-fallback"
  - "Email metadata (Subject, From) passed to LLM for contextual extraction signals"

requirements-completed: ["AIEX-01", "AIEX-02", "AIEX-03"]

# Metrics
duration: 25min
completed: 2026-03-29
---

# Phase 14 Plan 01: Extend CandidateExtractSchema and Fix Extraction Error Handling Summary

**CandidateExtractSchema extended to 10 fields with Zod validation, extract() error-swallowing bug removed, email metadata passed to OpenRouter callAI(), and extractDeterministically() made public for BullMQ final-attempt fallback**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-03-29T09:57:00Z
- **Completed:** 2026-03-29T10:02:00Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Extended CandidateExtractSchema from 5 to 10 fields: added `current_role`, `years_experience` (int, 0-50), `location`, `job_title_hint`, `source_hint` (enum)
- Removed error-swallowing try/catch from `extract()` — errors now propagate to BullMQ processor for retry
- Updated `callAI()` to prepend `--- Email Metadata ---` section with Subject and From before CV content
- Switched `callAI()` from `.parse()` to `.safeParse()` for explicit validation failure handling
- Made `extractDeterministically()` public, extended return type to include all 10 fields (new ones return null)
- Rewrote INSTRUCTIONS prompt with field constraints, format rules (integer not string for years), few-shot JSON example
- Updated all test helpers and inline mocks: `mockCandidateExtract`, `mockCandidateDedupExtract`, Phase 6 and Phase 7 processor mocks

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend CandidateExtractSchema + fix extract() error handling + update signatures** - `89bd893` (feat)
2. **Task 2: Update test helper with new CandidateExtract fields** - `e83aa24` (feat)

_Note: Task 1 followed TDD: wrote failing spec tests (RED) then implemented the service changes (GREEN)._

## Files Created/Modified
- `src/ingestion/services/extraction-agent.service.ts` - Extended 10-field schema, removed try/catch, added metadata param, safeParse(), public extractDeterministically()
- `src/ingestion/services/extraction-agent.service.spec.ts` - Updated tests: removed error-swallowing tests, added 7 new tests for new behavior
- `src/ingestion/services/extraction-agent.service.test-helpers.ts` - mockCandidateExtract now includes all 10 fields
- `src/dedup/dedup.service.spec.ts` - mockCandidateDedupExtract extended with 10 fields
- `src/ingestion/ingestion.processor.spec.ts` - Phase 6 and Phase 7 inline mocks extended with new fields

## Decisions Made
- Removed try/catch from extract() so errors propagate to BullMQ — the processor is the orchestrator, it should decide retry vs fallback vs permanent failure
- Used safeParse() over .parse() — both throw on validation failure, but safeParse() with explicit check communicates intent clearly and allows custom error messages
- Made extractDeterministically() public (not private) — processor can call it directly as final-attempt fallback without going through extract()
- FALLBACK constant retained (exposed via getFallback()) — may be useful in processor fallback logic

## Deviations from Plan

None — plan executed exactly as written.

Note: 6 pre-existing test failures exist in `jobs.integration.spec.ts` and `candidates.integration.spec.ts` (unrelated to schema changes — these involve missing mock properties for `tx.candidate.updateMany` and `prisma.jobStage.findFirst`). These failures were confirmed to pre-exist before this plan's changes and are documented in deferred items.

## Issues Encountered
- None — all changes were localized, tests passed on first run after implementation.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 02 (scoring) and Plan 03 (processor) can now use the extended `CandidateExtract` type
- `extractDeterministically()` is public and ready for processor to call on final BullMQ attempt
- All test helpers are updated with 10 fields — Plan 02 and Plan 03 tests will inherit correct mock structure
- One remaining gap: `ingestion.processor.ts` still calls `extract(fullText, suspicious)` without metadata — Plan 03 must add the metadata parameter

---
*Phase: 14-wire-openrouter-extraction-pipeline-email-llm-dedup-scoring-ui*
*Completed: 2026-03-29*
