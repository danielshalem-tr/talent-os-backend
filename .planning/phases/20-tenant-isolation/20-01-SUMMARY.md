---
phase: 20-tenant-isolation
plan: 01
subsystem: auth
tags: [nestjs, jwt, session-guard, tenant-isolation, multi-tenancy]

# Dependency graph
requires:
  - phase: 18-auth-foundation
    provides: SessionGuard, JwtService, JwtPayload with org field, AuthModule
provides:
  - SessionGuard applied at class level on all business controllers (candidates, jobs, applications, config)
  - tenantId extracted from req.session!.org and passed as argument to all service calls
  - TENANT_ID env var made optional (API server no longer requires it at startup)
  - AuthModule imported into CandidatesModule, JobsModule, ApplicationsModule, AppConfigModule
affects: [20-02, 20-03, candidates-service, jobs-service, applications-service]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Controller-level @UseGuards(SessionGuard) for uniform auth enforcement"
    - "tenantId extracted from req.session!.org in controller, passed as last service arg"
    - "AuthModule imported into business modules to provide SessionGuard and JwtService"

key-files:
  created: []
  modified:
    - src/config/env.ts
    - src/candidates/candidates.module.ts
    - src/jobs/jobs.module.ts
    - src/applications/applications.module.ts
    - src/config/app-config/app-config.module.ts
    - src/candidates/candidates.controller.ts
    - src/jobs/jobs.controller.ts
    - src/applications/applications.controller.ts
    - src/config/app-config/app-config.controller.ts

key-decisions:
  - "TENANT_ID made optional in env.ts — API server derives tenant from JWT session; IngestionProcessor still reads from config (no session in webhook flow)"
  - "Guard applied at class level (not per-route) for uniform enforcement with no per-method opt-in risk"
  - "Wave 1 intentionally incomplete without Wave 2 — service signatures updated in 20-02, TypeScript errors expected until then"

patterns-established:
  - "tenantId threading: controller extracts from session, passes as last arg to service methods"
  - "AuthModule imported into each business module — no global guard to preserve webhook bypass"

requirements-completed: []

# Metrics
duration: 15min
completed: 2026-04-14
---

# Phase 20 Plan 01: Wave 1 — SessionGuard on All Business Controllers + env.ts Updates

**SessionGuard wired at class level on all 4 business controllers with tenantId extracted from JWT session and threaded through every service call argument**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-14T00:00:00Z
- **Completed:** 2026-04-14
- **Tasks:** 6
- **Files modified:** 9

## Accomplishments
- TENANT_ID env var made optional — API server starts without it (webhook worker still reads from config)
- AuthModule imported into all 4 business modules (CandidatesModule, JobsModule, ApplicationsModule, AppConfigModule)
- @UseGuards(SessionGuard) applied at class level on all 4 controllers — all routes protected uniformly
- tenantId extracted from req.session!.org and passed to every service method call across 11 CandidatesController methods, 7 JobsController methods, and 1 ApplicationsController method

## Task Commits

Each task was committed atomically:

1. **Task 1: Make TENANT_ID optional in env.ts** - `21762c6` (feat)
2. **Task 2: Wire AuthModule into business modules** - `1f127de` (feat)
3. **Task 3: Guard and thread tenantId through CandidatesController** - `11c91bc` (feat)
4. **Task 4: Guard and thread tenantId through JobsController** - `7f2c78e` (feat)
5. **Task 5: Guard and thread tenantId through ApplicationsController** - `1f1672b` (feat)
6. **Task 6: Guard AppConfigController (auth only)** - `d0a1add` (feat)

## Files Created/Modified
- `src/config/env.ts` - TENANT_ID changed from required to optional
- `src/candidates/candidates.module.ts` - AuthModule added to imports
- `src/jobs/jobs.module.ts` - AuthModule added to imports
- `src/applications/applications.module.ts` - AuthModule added to imports
- `src/config/app-config/app-config.module.ts` - AuthModule added to imports
- `src/candidates/candidates.controller.ts` - @UseGuards(SessionGuard) + tenantId threading on 11 methods
- `src/jobs/jobs.controller.ts` - @UseGuards(SessionGuard) + tenantId threading on 7 methods
- `src/applications/applications.controller.ts` - @UseGuards(SessionGuard) + tenantId in findAll
- `src/config/app-config/app-config.controller.ts` - @UseGuards(SessionGuard) only (no tenantId needed)

## Decisions Made
- Guard applied at class level to avoid per-route opt-in risk — no route can be accidentally left unguarded
- AppConfigController guards auth only (no tenantId) because config is static/tenant-agnostic lookup tables
- Wave 1 is intentionally a partial refactor — TypeScript errors expected until Wave 2 updates service signatures

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None. Wave 1 is designed as a partial pass; TypeScript errors in service signatures are expected and will be resolved in Plan 20-02 (Wave 2).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Wave 1 complete — all controllers guard-protected and tenantId threaded through service call arguments
- Plan 20-02 (Wave 2) must update service signatures to accept tenantId and replace hardcoded ConfigService.get('TENANT_ID') calls
- TypeScript compilation will only pass after Wave 2 complete

---
*Phase: 20-tenant-isolation*
*Completed: 2026-04-14*
