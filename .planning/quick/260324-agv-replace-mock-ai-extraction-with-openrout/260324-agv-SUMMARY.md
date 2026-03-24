---
phase: quick
plan: 260324-agv
subsystem: ingestion/extraction
tags: [ai, openrouter, extraction, tdd]
tech-stack:
  added: ['@ai-sdk/openai']
  patterns: ['generateObject with schema validation', 'OpenRouter baseURL override via createOpenAI']
key-files:
  created:
    - src/ingestion/services/extraction-agent.service.test-helpers.ts
  modified:
    - src/ingestion/services/extraction-agent.service.ts
    - src/ingestion/services/extraction-agent.service.spec.ts
    - src/ingestion/ingestion.processor.spec.ts
    - src/config/env.ts
    - src/config/env.spec.ts
    - package.json
decisions:
  - 'OpenRouter with google/gemma-3-12b-it:free model — capable free-tier for structured JSON extraction'
  - 'generateObject with CandidateExtractSchema gives Zod-validated output eliminating hallucination risk on field types'
  - "Fallback fullName='' aligns with existing processor contract that marks intake as 'failed' on empty fullName"
  - 'mockCandidateExtract moved to dedicated test-helpers file to prevent Jest describe-block leaking across test suites'
metrics:
  duration: '~8 minutes'
  completed: '2026-03-24'
  tasks_completed: 2
  files_modified: 7
---

# Quick Task 260324-agv: Replace Mock AI Extraction with OpenRouter MVP Summary

**One-liner:** Real OpenRouter extraction replacing Jane Doe mock using @ai-sdk/openai generateObject with Zod schema validation and graceful fallback.

## What Was Done

Replaced the hardcoded `ExtractionAgentService.extract()` mock (which returned "Jane Doe" for every candidate) with a real OpenRouter API call using the Vercel AI SDK's `generateObject`. The service now:

1. Calls `https://openrouter.ai/api/v1` with model `google/gemma-3-12b-it:free`
2. Uses `CandidateExtractSchema` (Zod) for validated structured output
3. Returns a safe fallback with empty/null values on any error without throwing
4. Is validated at startup via `OPENROUTER_API_KEY` in `envSchema`

## Tasks Completed

| Task | Name                                                            | Commit  | Files                                                  |
| ---- | --------------------------------------------------------------- | ------- | ------------------------------------------------------ |
| 1    | Install @ai-sdk/openai and add OPENROUTER_API_KEY to env schema | bd0094d | src/config/env.ts, package.json                        |
| 2    | Implement real OpenRouter extraction with graceful fallback     | 1d93b1b | extraction-agent.service.ts, .spec.ts, test-helpers.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Jest describe-block leaking into ingestion.processor.spec.ts**

- **Found during:** Task 2 GREEN verification (full suite run)
- **Issue:** `ingestion.processor.spec.ts` imported `mockCandidateExtract` directly from `extraction-agent.service.spec.ts`. When Jest ran the processor spec, it also executed the `describe` block from the extraction spec. The `jest.mock('ai')` in the extraction spec wasn't in scope for the processor spec's module registry, causing the real `generateObject` to be called (resulting in auth failures).
- **Fix:** Extracted `mockCandidateExtract` into `extraction-agent.service.test-helpers.ts` (no describe blocks). Updated `ingestion.processor.spec.ts` to import from the helpers file. Re-exported from spec for backward compatibility.
- **Files modified:** `extraction-agent.service.test-helpers.ts` (created), `extraction-agent.service.spec.ts` (re-export), `ingestion.processor.spec.ts` (import path)
- **Commit:** 1d93b1b

**2. [Rule 1 - Bug] Added OPENROUTER_API_KEY to env.spec.ts validEnv fixture**

- **Found during:** Task 2 GREEN verification
- **Issue:** `env.spec.ts` validEnv object didn't include `OPENROUTER_API_KEY`, causing `envSchema.parse(validEnv)` tests to fail after the schema was updated.
- **Fix:** Added `OPENROUTER_API_KEY: 'sk-or-test'` to the validEnv fixture.
- **Files modified:** `src/config/env.spec.ts`
- **Commit:** 1d93b1b

## Verification Results

- `npm test`: 113 tests pass, 16 suites, 0 failures
- `npm run build`: compiles without TypeScript errors
- No reference to 'Jane Doe' in extraction-agent.service.ts
- `generateObject` called with OpenRouter baseURL
- Fallback returns `{ fullName: '', suspicious, skills: [], ... }` without throwing
- `OPENROUTER_API_KEY` validated in envSchema

## Known Stubs

None — the extraction service now calls real OpenRouter. The model (`google/gemma-3-12b-it:free`) is intentional for the free-tier MVP.

## Self-Check: PASSED

- `src/ingestion/services/extraction-agent.service.ts` — FOUND
- `src/ingestion/services/extraction-agent.service.test-helpers.ts` — FOUND
- `src/config/env.ts` contains OPENROUTER_API_KEY — FOUND
- Commits bd0094d, 072c13a, 1d93b1b — verified in git log
