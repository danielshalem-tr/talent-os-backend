---
phase: 20-tenant-isolation
plan: 02
subsystem: auth
tags: [nestjs, tenant-isolation, service-refactor, multi-tenancy]

# Dependency graph
requires:
  - phase: 20-01
    provides: SessionGuard on controllers, tenantId extracted from req.session.org
provides:
  - CandidatesService, JobsService, ApplicationsService accept tenantId as explicit param
  - ConfigService removed from all 3 business services
  - TypeScript compilation clean (0 errors in production code)
  - Wave 1 + Wave 2 together form complete tenant isolation for business API
affects: [20-03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Service methods accept tenantId as explicit param — no config lookup in business layer"
    - "import type { Request } for express Request in controllers with isolatedModules"

key-files:
  created: []
  modified:
    - src/candidates/candidates.service.ts
    - src/jobs/jobs.service.ts
    - src/applications/applications.service.ts
    - src/candidates/candidates.controller.ts
    - src/jobs/jobs.controller.ts
    - src/applications/applications.controller.ts

key-decisions:
  - "ConfigService removed from all 3 business services — tenantId comes from controller (session JWT)"
  - "import type for express Request in controllers — required by isolatedModules + emitDecoratorMetadata"
  - "IngestionProcessor and WebhooksService untouched — verified still use configService.get(TENANT_ID)"

requirements-completed: []

# Metrics
duration: 20min
completed: 2026-04-14
---

# Phase 20 Plan 02: Wave 2 — Service Method Signature Refactor (tenantId as Param)

**CandidatesService, JobsService, and ApplicationsService refactored to accept tenantId as explicit parameter — ConfigService removed from all 3 business services, TypeScript compilation clean with 0 production errors**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-04-14T00:00:00Z
- **Completed:** 2026-04-14
- **Tasks:** 4
- **Files modified:** 6

## Accomplishments

- `CandidatesService`: 11 public methods updated to accept `tenantId: string`, `ConfigService` removed from constructor
- `JobsService`: 7 public methods updated to accept `tenantId: string`, `ConfigService` removed from constructor
- `ApplicationsService`: `findAll` updated to accept `tenantId: string`, `ConfigService` removed from constructor
- Internal method calls threaded with tenantId (`findOne`, `saveStageSummary`, `updateStage` called from within service)
- IngestionProcessor and WebhooksService verified untouched (still use config-based TENANT_ID)
- TypeScript: 0 errors in production code after Wave 1 + Wave 2 complete

## Task Commits

Each task was committed atomically:

1. **Task 1: Refactor CandidatesService** - `a595bdf` (feat)
2. **Task 2: Refactor JobsService** - `8eb724d` (feat)
3. **Task 3: Refactor ApplicationsService** - `7feb03d` (feat)
4. **Task 4: Verify untouched services + fix TS1272** - `67ec3d7` (fix)

## Files Created/Modified

- `src/candidates/candidates.service.ts` — 11 methods refactored, ConfigService removed
- `src/jobs/jobs.service.ts` — 7 methods refactored, ConfigService removed
- `src/applications/applications.service.ts` — findAll refactored, ConfigService removed
- `src/candidates/candidates.controller.ts` — `import type { Request }` fix
- `src/jobs/jobs.controller.ts` — `import type { Request }` fix
- `src/applications/applications.controller.ts` — `import type { Request }` fix

## Decisions Made

- Internal service calls within CandidatesService that call other service methods (findOne, saveStageSummary, updateStage) had tenantId threaded through them
- ConfigModule is global (isGlobal: true in AppModule) — no module-level ConfigModule import changes needed
- `import type { Request }` needed for isolatedModules + emitDecoratorMetadata compatibility

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TS1272 import type error for Request in controllers**
- **Found during:** Task 4 (TypeScript verification)
- **Issue:** `import { Request } from 'express'` in controller files caused TS1272 when `isolatedModules` and `emitDecoratorMetadata` are both enabled and Request is used in decorated method signatures
- **Fix:** Changed to `import type { Request } from 'express'` in CandidatesController, JobsController, ApplicationsController
- **Files modified:** candidates.controller.ts, jobs.controller.ts, applications.controller.ts
- **Commit:** `67ec3d7`

## Issues Encountered

Test files have TypeScript errors (TS2554 - wrong argument counts) because test mocks still call service methods with old signatures. This is expected behavior per plan — Wave 3 handles test updates.

## User Setup Required

None.

## Next Phase Readiness

- Wave 1 + Wave 2 complete — tenant isolation fully operational for all business API endpoints
- TypeScript compilation: 0 errors in production code
- Plan 20-03 must update test files to pass tenantId in all service method calls and update mock setups

---

## Self-Check: PASSED

- [x] `src/candidates/candidates.service.ts` — modified, verified
- [x] `src/jobs/jobs.service.ts` — modified, verified
- [x] `src/applications/applications.service.ts` — modified, verified
- [x] Commits `a595bdf`, `8eb724d`, `7feb03d`, `67ec3d7` — all present in git log
- [x] `npx tsc --noEmit` — 0 errors in production files

---
*Phase: 20-tenant-isolation*
*Completed: 2026-04-14*
