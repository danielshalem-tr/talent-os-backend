---
phase: 20
plan: "03"
subsystem: tests
tags: [tenant-isolation, testing, wave-3]
dependency_graph:
  requires: [20-01, 20-02]
  provides: [green-test-suite, phase-20-complete]
  affects: [candidates, jobs, applications]
tech_stack:
  added: []
  patterns: [MockSessionGuard, tenantId-as-explicit-param]
key_files:
  modified:
    - src/candidates/candidates.service.spec.ts
    - src/candidates/candidates.integration.spec.ts
    - src/candidates/candidates.controller.spec.ts
    - src/jobs/jobs.service.spec.ts
    - src/jobs/jobs.controller.spec.ts
    - src/applications/applications.service.spec.ts
decisions:
  - "MockSessionGuard injects req.session in canActivate() so controller reads tenantId correctly in supertest tests"
  - "Integration spec uses direct constructor instantiation — removed ConfigService arg, added mockReq to all controller calls"
  - "Service spec describe blocks: removed ConfigService from NestJS module providers entirely"
metrics:
  duration: "~25 minutes"
  completed_date: "2026-04-14"
  tasks_completed: 8
  files_modified: 6
---

# Phase 20 Plan 03: Wave 3 — Test Updates + Full Suite Verification Summary

All 6 affected test files updated to match the new service signatures introduced in waves 1 and 2. Test suite went from failing to 313 passing / 0 failing. TypeScript: 0 errors.

## What Was Done

### Task 1 — `candidates.service.spec.ts`
- Removed `ConfigService` import and all `{ provide: ConfigService, useValue: mockConfig }` entries from every `describe` block (5 separate module setups)
- Updated `findAll()` → `findAll(TENANT_ID, ...)` with tenantId as first param across all 5 describe blocks
- Updated `createCandidate(dto, file)` → `createCandidate(dto, file, TENANT_ID)`
- Updated `deleteCandidate(id)` → `deleteCandidate(id, TENANT_ID)`
- Updated `updateCandidate(id, dto)` → `updateCandidate(id, dto, TENANT_ID)`

### Task 2 — `candidates.integration.spec.ts`
- Removed `ConfigService` import
- Fixed `CandidatesService` constructor call: removed `mockConfig` arg (no longer accepted)
- Fixed `JobsService` constructor call: removed `mockConfig` arg (no longer accepted)
- Added `mockReq = { session: { org: TENANT_ID, sub: 'user-uuid', role: 'admin' } }` at module level
- Updated all `controller.create(file, body)` → `controller.create(mockReq, file, body)`
- Updated all `controller.getOpenJobs()` → `controller.getOpenJobs(mockReq)`

### Task 3 — `candidates.controller.spec.ts`
- Added `MockSessionGuard implements CanActivate` that sets `req.session = { org: TENANT_ID, ... }` and returns true
- Added `.overrideGuard(SessionGuard).useClass(MockSessionGuard)` to NestJS testing module
- Updated `findAll` `toHaveBeenCalledWith` assertions: prepended `TENANT_ID` as first arg (3 assertions)

### Task 4 — `jobs.service.spec.ts`
- Removed `ConfigService` import, `mockConfigService` variable, and all provider references
- Removed `mockConfigService.get.mockReturnValue(TENANT_ID)` call from beforeEach
- Updated all 8 `createJob({...})` → `createJob({...}, TENANT_ID)` calls
- Updated all `findAll()` / `findAll('open')` → `findAll(TENANT_ID)` / `findAll(TENANT_ID, 'open')`
- Updated `findOne('job-1')` → `findOne('job-1', TENANT_ID)`
- Updated `deleteJob('job-1')` → `deleteJob('job-1', TENANT_ID)`
- Updated all `hardDeleteJob(...)` → `hardDeleteJob(..., TENANT_ID)`
- Removed `expect(mockConfigService.get).toHaveBeenCalledWith('TENANT_ID')` assertion
- Updated test description from "assigns tenantId from ConfigService" to "assigns tenantId param"

### Task 5 — `jobs.controller.spec.ts`
- Added `TENANT_ID` constant and `mockReq` at describe level
- Updated all controller method calls to pass `mockReq` in correct position
- Updated service mock `toHaveBeenCalledWith` assertions: added `TENANT_ID` and `mockReq` args to `findAll`, `createJob`, `updateJob`, `deleteJob`, `hardDeleteJob`, `findOne`

### Task 6 — `applications.service.spec.ts`
- Removed `ConfigService` import, `mockConfigService` variable, and provider entry
- Removed `mockConfigService.get.mockReturnValue(TENANT_ID)` from beforeEach
- Updated `service.findAll()` → `service.findAll(TENANT_ID)` (5 occurrences)
- Removed `expect(mockConfigService.get).toHaveBeenCalledWith('TENANT_ID')` assertion
- Updated test description to "WHERE includes tenantId param"

### Task 7 — Full Test Suite
- `npm test`: 313 passed, 0 failed, 23 todo, 27 suites

### Task 8 — TypeScript Check
- `npx tsc --noEmit`: 0 errors

## Verification

- `npm test`: 313/313 passing
- `npx tsc --noEmit`: 0 errors

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Missing mockReq in integration spec getOpenJobs test**
- **Found during:** Task 7 (test run)
- **Issue:** One `controller.getOpenJobs()` call in the integration spec (line 341) was missed during Task 2 edits — caused `TypeError: Cannot read properties of undefined (reading 'session')`
- **Fix:** Added `mockReq` arg: `controller.getOpenJobs(mockReq)`
- **Files modified:** `src/candidates/candidates.integration.spec.ts`
- **Commit:** 0babacc

## Known Stubs

None — this plan only modifies test files, no production stubs introduced.

## Threat Flags

None — test-only changes, no new network surface.

## Self-Check: PASSED

- `.planning/phases/20-tenant-isolation/20-03-SUMMARY.md` — this file (created now)
- Commit a144023 — test file updates
- Commit 0babacc — fix missing mockReq
