---
phase: quick-260326-dyi
plan: 01
subsystem: jobs-api
tags: [query-param, filter, jobs, controller, service]
dependency_graph:
  requires: []
  provides: [status-filter-on-get-jobs]
  affects: [jobs.controller.ts, jobs.service.ts]
tech_stack:
  added: []
  patterns: [nestjs-query-decorator, prisma-conditional-where]
key_files:
  created: []
  modified:
    - src/jobs/jobs.controller.ts
    - src/jobs/jobs.service.ts
    - src/jobs/jobs.controller.spec.ts
    - src/jobs/jobs.service.spec.ts
decisions:
  - No Zod validation on status — invalid values return 0 results (pass-through string filter per plan spec)
metrics:
  duration: "5 minutes"
  completed_date: "2026-03-26"
  tasks_completed: 1
  files_changed: 4
---

# Quick Task 260326-dyi: Add Status Query Param to Jobs Endpoint Summary

**One-liner:** Optional `?status=` query param on GET /jobs routes Prisma `where` filter through `@Query` decorator on controller to `findAll(status?)` on service.

## What Was Done

Added an optional `status` query parameter to `GET /jobs` enabling callers to filter jobs by status (e.g. `?status=open`, `?status=draft`). When omitted, all jobs are returned unchanged.

## Changes

**`src/jobs/jobs.service.ts`**
- `findAll()` signature updated to `findAll(status?: string)`
- Prisma `where` clause now uses `{ tenantId, ...(status ? { status } : {}) }`

**`src/jobs/jobs.controller.ts`**
- Added `Query` to `@nestjs/common` imports
- `findAll()` handler updated to `async findAll(@Query('status') status?: string)` and calls `this.jobsService.findAll(status)`

**`src/jobs/jobs.service.spec.ts`** — 2 new tests:
- "passes status filter to Prisma when provided" — asserts `where` includes `{ status: 'open' }`
- "omits status filter when not provided" — asserts `where` equals `{ tenantId }` only

**`src/jobs/jobs.controller.spec.ts`** — 2 new tests:
- "passes status param to service" — asserts service called with `'open'`
- "calls service with undefined when no status param" — asserts service called with `undefined`

## Test Results

- 4 new tests added and passing
- 194 pre-existing tests passing (no regressions introduced)
- 5 pre-existing failures exist (out-of-scope, from Phase 07-01 DEFAULT_HIRING_STAGES expansion)

## Deviations from Plan

None — plan executed exactly as written.

## Known Out-of-Scope Issues (Pre-existing)

5 test failures pre-existed before this task (confirmed via `git stash` check):

| Test | File | Root Cause |
|------|------|-----------|
| D-04: auto-seeds 4 default stages | jobs.service.spec.ts | Phase 07-01 expanded DEFAULT_HIRING_STAGES from 4 to 8; test not updated |
| GET /config hiring_stages_template has 4 elements | jobs.integration.spec.ts | Phase 07-01 expanded template to 8 stages; 3 related tests not updated |
| POST /jobs seeds 4 default stages | jobs.integration.spec.ts | Same root cause |

These are logged here for tracking but are out of scope for this task.

## Commits

| Hash | Message |
|------|---------|
| 0b033fd | feat(quick-260326-dyi-01): add optional status query param to GET /jobs |

## Self-Check: PASSED

- [x] `src/jobs/jobs.controller.ts` exists and contains `@Query`
- [x] `src/jobs/jobs.service.ts` exists and `findAll` accepts `status?`
- [x] Commit `0b033fd` exists
- [x] 4 new tests pass
- [x] No regressions in previously passing tests
