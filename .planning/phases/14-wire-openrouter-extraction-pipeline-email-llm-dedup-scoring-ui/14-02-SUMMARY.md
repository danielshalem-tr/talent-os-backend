---
phase: 14-wire-openrouter-extraction-pipeline-email-llm-dedup-scoring-ui
plan: "02"
subsystem: scoring
tags: [openrouter, scoring, llm, config]
dependency_graph:
  requires: []
  provides: [real-openrouter-scoring]
  affects: [scoring-pipeline]
tech_stack:
  added: []
  patterns: [openrouter-callModel, configservice-injection, zod-safeParse]
key_files:
  created: []
  modified:
    - src/scoring/scoring.service.ts
    - src/scoring/scoring.module.ts
    - src/scoring/scoring.service.spec.ts
decisions:
  - "Use google/gemini-2.0-flash:free (not claude-sonnet) for scoring — free tier, consistent with extraction service provider"
  - "Return modelUsed = 'google/gemini-2.0-flash' without :free suffix — matches how model identifier appears in API responses"
  - "Throw (not swallow) on API failure or schema validation failure — caller (IngestionProcessor) handles per-job error isolation"
metrics:
  duration_seconds: 108
  completed_date: "2026-03-29"
  tasks_completed: 2
  files_modified: 3
---

# Phase 14 Plan 02: OpenRouter Scoring Service Summary

**One-liner:** Replace hardcoded mock scoring (score=72) with real OpenRouter google/gemini-2.0-flash:free LLM call; inject ConfigService; add ConfigModule to ScoringModule.

## What Was Built

- `ScoringAgentService.score()` now calls OpenRouter API with `google/gemini-2.0-flash:free` model
- ConfigService injected via constructor to retrieve `OPENROUTER_API_KEY`
- Response validated with `ScoreSchema.safeParse()` — throws on schema failure
- Markdown code fences stripped from model response (consistent with extraction service pattern)
- `modelUsed` returns `'google/gemini-2.0-flash'` (no `:free` suffix)
- `ScoringModule` now imports `ConfigModule` so NestJS DI can resolve `ConfigService`
- 7 new spec tests (up from 3) verifying real OpenRouter behavior, not hardcoded mock

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 3 (RED) | Failing tests for OpenRouter scoring | 8a8e4fc | scoring.service.spec.ts |
| 3 (GREEN) | Rewrite ScoringAgentService with OpenRouter | d5b03c4 | scoring.service.ts |
| 4 | Add ConfigModule to ScoringModule | 7439d7e | scoring.module.ts |

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None — `score()` makes a real OpenRouter API call. No hardcoded values remain.

## Pre-existing Issues (Out of Scope)

`candidates/candidates.integration.spec.ts` has 2 failing tests (6 failures) due to `this.prisma.jobStage.findFirst` being undefined. This pre-dates this plan and is unrelated to scoring changes. Logged for tracking.

## Self-Check: PASSED

- `src/scoring/scoring.service.ts` — FOUND
- `src/scoring/scoring.module.ts` — FOUND
- `src/scoring/scoring.service.spec.ts` — FOUND
- Commit 8a8e4fc — FOUND (test RED phase)
- Commit d5b03c4 — FOUND (feat GREEN phase)
- Commit 7439d7e — FOUND (feat ConfigModule)
- 7 scoring tests passing — CONFIRMED
