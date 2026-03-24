---
phase: quick-260324-c3g
plan: 01
subsystem: ingestion
tags: [openrouter, ai-extraction, prisma, seed]

requires: []
provides:
  - "ExtractionAgentService without ENABLE_AI_EXTRACTION flag — AI always attempted"
  - "callAI() private method isolating all @openrouter/sdk code as single swap point"
  - "Two seeded candidates (Yael Cohen, Noam Levy) in Triolla tenant"
affects: [ingestion, seed-data, future-ai-provider-swap]

tech-stack:
  added: []
  patterns:
    - "AI provider isolation: all provider-specific code in one private callAI() method with swap comment"
    - "Error fallback returns FALLBACK constant (empty/null) not deterministic extraction"

key-files:
  created: []
  modified:
    - src/ingestion/services/extraction-agent.service.ts
    - prisma/seed.ts

key-decisions:
  - "Error fallback uses FALLBACK constant (empty/null values) not extractDeterministically — aligns with test expectations"
  - "Seed source changed from 'email' to 'direct' — candidates_source_check only allows: linkedin, website, agency, referral, direct"

patterns-established:
  - "AI_PROVIDER comment above callAI() marks it as the only method to change when swapping AI providers"

requirements-completed: []

duration: 8min
completed: 2026-03-24
---

# Quick Task 260324-c3g: Clean Up extraction-agent.service.ts Summary

**Removed ENABLE_AI_EXTRACTION=false flag from ExtractionAgentService, isolated all @openrouter/sdk code into a single private callAI() method, and added two idempotent seed candidates to prisma/seed.ts**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-03-24T05:45:00Z
- **Completed:** 2026-03-24T05:53:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Removed ENABLE_AI_EXTRACTION = false flag — AI extraction now always attempted on every call
- Isolated all @openrouter/sdk code into private callAI() method with provider-swap comment
- 8 extraction-agent service tests now exercise the real code path (mocks were bypassed before)
- Two seed candidates added (Yael Cohen, Noam Levy) with hardcoded UUIDs for idempotency
- Seed runs idempotently — no unique constraint errors on re-run

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove ENABLE_AI_EXTRACTION flag and isolate provider code** - `4977b32` (refactor)
2. **Task 2: Add two seed candidates to prisma/seed.ts** - `80645f8` (feat)

## Files Created/Modified

- `src/ingestion/services/extraction-agent.service.ts` - Removed flag, restructured with callAI() private method
- `prisma/seed.ts` - Added upserts for Yael Cohen (000...101) and Noam Levy (000...102)

## Decisions Made

- Error fallback returns `FALLBACK` constant (all null/empty values) rather than `extractDeterministically()`. The spec tests assert `full_name: ''` and `ai_summary: null` on error — deterministic extraction from "some text" would return `full_name: 'some text'`, which would fail the tests. FALLBACK constant is the correct safe baseline.
- Seed `source` changed from `'email'` to `'direct'` because the DB has a `candidates_source_check` CHECK constraint limiting values to: `linkedin`, `website`, `agency`, `referral`, `direct`. The `'email'` value violates this constraint.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Error fallback uses FALLBACK constant, not extractDeterministically()**
- **Found during:** Task 1 (test verification)
- **Issue:** Plan said "call extractDeterministically on error" but tests assert `full_name: ''` and `ai_summary: null`. extractDeterministically("some text") returns `full_name: 'some text'` and a non-null ai_summary — 1 test failed.
- **Fix:** Catch block returns `{ ...FALLBACK, suspicious }` instead of calling extractDeterministically
- **Files modified:** src/ingestion/services/extraction-agent.service.ts
- **Verification:** All 8 extraction-agent.service.spec tests pass
- **Committed in:** 4977b32 (Task 1 commit)

**2. [Rule 1 - Bug] Seed source changed from 'email' to 'direct'**
- **Found during:** Task 2 (seed run verification)
- **Issue:** `candidates_source_check` CHECK constraint only allows: linkedin, website, agency, referral, direct. Value 'email' violates constraint, seed failed with error code 23514.
- **Fix:** Changed both candidates' source from 'email' to 'direct'
- **Files modified:** prisma/seed.ts
- **Verification:** Seed runs successfully, logs 3 lines; idempotent on second run
- **Committed in:** 80645f8 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — bugs)
**Impact on plan:** Both fixes necessary for correctness. Error fallback fix aligned with test specification. Source fix aligned with DB schema constraints.

## Issues Encountered

None beyond the auto-fixed bugs above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- ExtractionAgentService is clean and provider-ready — swapping to @ai-sdk/anthropic requires only rewriting callAI()
- Two seed candidates available for testing upcoming job creation feature
- All 114 tests pass across 16 suites (no regressions)

---
*Phase: quick-260324-c3g*
*Completed: 2026-03-24*
