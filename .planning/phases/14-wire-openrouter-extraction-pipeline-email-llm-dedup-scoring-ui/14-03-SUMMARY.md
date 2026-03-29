---
phase: 14-wire-openrouter-extraction-pipeline-email-llm-dedup-scoring-ui
plan: "03"
subsystem: ingestion
tags: [bullmq, extraction, dedup, scoring, candidate-enrichment, job-matching, openrouter]

# Dependency graph
requires:
  - phase: 14-01
    provides: Extended CandidateExtract type with new fields and extractDeterministically() public method
  - phase: 14-02
    provides: ScoringAgentService with real OpenRouter scoring
provides:
  - IngestionProcessor with metadata flowing to extract(), enrichment fields from extraction, job matching, and deterministic fallback
  - DedupService.insertCandidate() with optional source parameter
  - 7 Phase14 integration tests for pipeline correctness
affects: [ingestion, dedup, scoring, candidate-enrichment, phase-15-onwards]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Final-attempt deterministic fallback: catch block checks job.attemptsMade >= (job.opts?.attempts ?? 3) - 1 before calling extractDeterministically()"
    - "Levenshtein similarity for in-process job matching before pg_trgm query results"
    - "source_hint flows extraction → insertCandidate() → candidate record"

key-files:
  created: []
  modified:
    - src/ingestion/ingestion.processor.ts
    - src/ingestion/ingestion.processor.spec.ts
    - src/dedup/dedup.service.ts
    - src/dedup/dedup.service.spec.ts
    - src/ingestion/services/extraction-agent.service.ts
    - src/ingestion/services/extraction-agent.service.spec.ts
    - src/ingestion/services/extraction-agent.service.test-helpers.ts

key-decisions:
  - "Job matching uses in-process Levenshtein similarity (not pg_trgm raw query) for prototype — sufficient for Phase 1 scale"
  - "Emails with no matching job are rejected (failed) rather than queued — job_title_hint is required for pipeline completion"
  - "Deterministic fallback on final attempt: sets suspicious=true, source_hint=null; continues even if no job match (email rejected gracefully)"

patterns-established:
  - "extraction!.field: Use non-null assertion after try/catch where TypeScript cannot prove assignment on all paths"
  - "Phase 6.5 job matching runs after dedup Phase 6 — candidate is already inserted before matching check"

requirements-completed: ["CAND-01", "CAND-02", "CAND-03", "SCOR-01", "SCOR-02", "SCOR-03", "SCOR-04", "SCOR-05"]

# Metrics
duration: 45min
completed: "2026-03-29"
---

# Phase 14 Plan 03: Wire IngestionProcessor — Metadata, Enrichment, Job Matching, Deterministic Fallback

**End-to-end extraction pipeline wired: metadata flows into extract(), enrichment uses extracted fields, job matching added (Phase 6.5), BullMQ retry and deterministic fallback on final attempt**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-03-29T10:00:00Z
- **Completed:** 2026-03-29T10:15:00Z
- **Tasks:** 2 (Task 5 + Task 6)
- **Files modified:** 7

## Accomplishments

- DedupService.insertCandidate() accepts optional `source` parameter (5th arg), defaults to 'direct'
- IngestionProcessor passes Subject + From as metadata object to extractionAgent.extract()
- Phase 7 candidate enrichment now uses extraction.current_role, extraction.years_experience, extraction.location (no more hardcoded null)
- Phase 6.5 job matching uses Levenshtein similarity on extraction.job_title_hint — rejects emails with no matching active job
- candidate.update now includes jobId and hiringStageId from matched job
- BullMQ catch block: non-final attempts re-throw; final attempt calls extractDeterministically() and continues
- extraction.source_hint passed to both insertCandidate() branches (fuzzy + no-match)
- 30 total processor tests passing (7 new Phase14 tests)

## Task Commits

1. **Plan 01 dependency: Extend CandidateExtractSchema + fix error handling** - `480dbe2` (feat)
2. **Task 5: Update DedupService.insertCandidate() with source parameter** - `f16553e` (feat)
3. **Task 6: Update IngestionProcessor — metadata, enrichment, job matching, fallback** - `5e5c967` (feat)
4. **Task 6 fix: extend test body text to pass spam filter threshold** - `b9bdad0` (fix)

## Files Created/Modified

- `src/ingestion/services/extraction-agent.service.ts` - Extended 5-field schema to 10 fields; extract() now propagates errors; extractDeterministically() made public
- `src/ingestion/services/extraction-agent.service.test-helpers.ts` - Updated mock with all new fields (current_role, years_experience, etc.)
- `src/ingestion/services/extraction-agent.service.spec.ts` - Updated tests for new behavior (extract throws, metadata in callAI, extractDeterministically public)
- `src/dedup/dedup.service.ts` - insertCandidate() accepts optional source?: string | null (5th param)
- `src/dedup/dedup.service.spec.ts` - 2 new tests: source param used/defaults to 'direct'
- `src/ingestion/ingestion.processor.ts` - 6 changes: metadata to extract(), deterministic fallback, Phase 6.5 job matching, enrichment fields, source_hint to insertCandidate()
- `src/ingestion/ingestion.processor.spec.ts` - 7 new Phase14 tests; updated existing mocks to include job.findFirst and new extraction fields

## Decisions Made

- Job matching uses in-process Levenshtein similarity rather than direct pg_trgm raw query — simpler for processor code, sufficient for Phase 1 volume (500 CVs/month)
- Emails without a matching job are hard-rejected (status: 'failed') — a candidate cannot proceed without job assignment
- On final BullMQ attempt, deterministic fallback still continues through full pipeline even with partial data (null for most fields)
- Plan 01 changes (CandidateExtract type extension) applied in this worktree as a dependency prerequisite for Plan 03 changes to compile

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed spam filter rejection in Phase14 tests (TextBody < 100 chars)**
- **Found during:** Task 6 testing
- **Issue:** validPayload() TextBody was 97 chars — spam filter rejects emails with no attachment AND body < 100 chars
- **Fix:** Extended TextBody to 170 chars with additional sentence
- **Files modified:** src/ingestion/ingestion.processor.spec.ts
- **Verification:** All 7 Phase14 tests now pass
- **Committed in:** b9bdad0

**2. [Rule 3 - Blocking] Applied Plan 01 (CandidateExtract extension) as prerequisite**
- **Found during:** Task 5 setup
- **Issue:** Plan 03 depends on Plan 01 (new CandidateExtract type) but worktree started from unmodified main branch — Plan 01 changes not present
- **Fix:** Applied Plan 01 extraction service changes (schema extension, method signatures, extractDeterministically public) to this worktree
- **Files modified:** extraction-agent.service.ts, extraction-agent.service.test-helpers.ts, extraction-agent.service.spec.ts
- **Verification:** 12 extraction service tests pass
- **Committed in:** 480dbe2

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both auto-fixes essential for plan execution. No scope creep.

## Issues Encountered

- TypeScript definite assignment analysis: `let extraction: CandidateExtract` used with `!` assertions after try/catch where TS cannot prove assignment — acceptable pattern for BullMQ catch blocks with complex branching

## Known Stubs

None — all data now flows from real extraction values. No hardcoded nulls for currentRole or yearsExperience remain in the processor.

## Next Phase Readiness

- IngestionProcessor pipeline fully wired end-to-end: email metadata → extraction → dedup → job matching → candidate enrichment → scoring
- Requires Plans 01 and 02 to be merged from parallel agents for full pipeline to work in production
- Phase 15+ can build on the complete candidate record with jobId, hiringStageId, currentRole, yearsExperience, location, source_hint

---
*Phase: 14-wire-openrouter-extraction-pipeline-email-llm-dedup-scoring-ui*
*Completed: 2026-03-29*
