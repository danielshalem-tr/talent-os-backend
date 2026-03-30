---
phase: quick-260330-idw
plan: 01
subsystem: jobs-api
tags: [rest-api, jobs, endpoint, tdd]
dependency_graph:
  requires: [JobsService.findAll, JobsService._formatJobResponse]
  provides: [GET /jobs/:id, JobsService.findOne]
  affects: [jobs.service.ts, jobs.controller.ts]
tech_stack:
  added: []
  patterns: [findFirst-with-tenantId-scope, NotFoundException-error-shape]
key_files:
  created: []
  modified:
    - src/jobs/jobs.service.ts
    - src/jobs/jobs.controller.ts
    - src/jobs/jobs.service.spec.ts
    - src/jobs/jobs.controller.spec.ts
decisions:
  - "@Get(':id') placed after @Get('list') and before @Post() to ensure NestJS resolves literal segment 'hard' before ':id' param, preventing route shadowing"
metrics:
  duration: "~5 minutes"
  completed: "2026-03-30T10:17:53Z"
  tasks_completed: 1
  tasks_total: 1
  files_changed: 4
---

# Phase quick-260330-idw Plan 01: Add GET /jobs/:id Endpoint Summary

**One-liner:** GET /jobs/:id endpoint with findOne() using findFirst+tenantId scope, identical response shape to list items, 404 on miss.

## What Was Built

Added a `GET /jobs/:id` endpoint to the jobs API so the frontend kanban board and job detail views can fetch a single job without loading all jobs.

### JobsService.findOne(id)

- Uses `prisma.job.findFirst({ where: { id, tenantId }, include: { hiringStages, screeningQuestions, _count } })`
- Throws `NotFoundException({ error: { code: 'NOT_FOUND', message: 'Job not found' } })` when result is null (covers both truly missing and cross-tenant isolation)
- Returns `this._formatJobResponse(job)` — identical shape to a single item from `findAll()`

### JobsController @Get(':id')

- Declared after `@Get('list')` and before `@Post()`, which ensures it appears before `@Delete(':id/hard')` in the source file
- NestJS registers routes in declaration order: placing `':id'` before `':id/hard'` ensures the literal `hard` segment is resolved correctly
- Delegates directly to `this.jobsService.findOne(id)` — no try/catch needed since NotFoundException is already an HTTP exception

## Tests Added

**jobs.service.spec.ts — findOne() describe block (4 tests):**
1. Returns formatted job when found (verifies hiring_flow, screening_questions, candidate_count shape)
2. Calls findFirst with id and tenantId (verifies tenant scoping)
3. Throws NotFoundException when findFirst returns null
4. NotFoundException has correct error shape (`{ error: { code: 'NOT_FOUND', message: 'Job not found' } }`)

**jobs.controller.spec.ts — GET /jobs/:id describe block (2 tests):**
1. Calls jobsService.findOne(id) and returns result
2. Propagates NotFoundException when service throws it

**Result:** 48 tests passing (42 existing + 6 new), 0 regressions.

## Commits

| Hash | Message |
|------|---------|
| fcf3bae | feat(quick-260330-idw): add GET /jobs/:id endpoint with findOne() service method |

## Deviations from Plan

None — plan executed exactly as written. TDD flow: RED (6 failing tests) → GREEN (48 passing tests). No refactor step needed.

**Pre-existing failures (out of scope):** 4 failing tests in `jobs.integration.spec.ts` related to `updateJob` candidate detachment — these existed before this task and are unrelated to the `findOne` addition. They were verified as pre-existing via `git stash` check.

## Known Stubs

None — endpoint is fully wired. findOne() calls real Prisma, returns real data.

## Self-Check: PASSED

- [x] `src/jobs/jobs.service.ts` — contains `findOne`
- [x] `src/jobs/jobs.controller.ts` — contains `@Get(':id')` before `@Delete(':id/hard')`
- [x] `src/jobs/jobs.service.spec.ts` — contains `describe('findOne()'`
- [x] `src/jobs/jobs.controller.spec.ts` — contains `describe('GET /jobs/:id'`
- [x] Commit fcf3bae exists: `git log --oneline | grep fcf3bae`
