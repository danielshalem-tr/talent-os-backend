---
phase: 17-production-deployment-readiness-fix-tests-add-sanity-checks-and-prepare-ci-cd-for-hetzner-jenkins
plan: '03'
subsystem: api
tags: [helmet, throttler, cors, security, nestjs, http-security-headers]

# Dependency graph
requires:
  - phase: 17-02
    provides: health endpoint and structured logging wired into main.ts
provides:
  - helmet HTTP security headers applied globally at bootstrap
  - CORS deny-all (origin: false) replaces localhost:5173 exception
  - ThrottlerModule rate-limiting at 100 req/60s per IP
  - ThrottlerGuard on POST /webhooks/email endpoint
  - All 5 API controllers verified against PROTOCOL.md — no tenantId leaks, snake_case throughout
  - Structured error format { error: { code, message, details } } applied consistently
affects: [17-04, 17-05, ci-cd, deployment]

# Tech tracking
tech-stack:
  added: [helmet, @nestjs/throttler]
  patterns:
    - "Security middleware applied before body parsers in bootstrap"
    - "ThrottlerGuard as outermost guard — runs before auth check on rate-limited endpoints"
    - "safeParse pattern for Zod validation — structured { error: { code, message, details } } on failure"

key-files:
  created: []
  modified:
    - src/main.ts
    - src/app.module.ts
    - src/webhooks/webhooks.controller.ts
    - src/webhooks/webhooks.controller.spec.ts
    - src/candidates/candidates.service.ts

key-decisions:
  - "CORS set to origin: false (deny-all) — API serves only Postmark webhooks in Phase 1, no browser clients"
  - "ThrottlerGuard placed before PostmarkAuthGuard — rate limiting runs before auth to prevent brute force"
  - "All BadRequestException calls now use { error: { code, message } } object format, never plain strings"

patterns-established:
  - "Error format: all exceptions use { error: { code, message, details? } } — enforced in controllers and services"
  - "Security middleware order: helmet() → bodyParser → cors → setGlobalPrefix → listen"

requirements-completed: [D-14, D-15, D-16, D-17, D-18, D-19, D-20]

# Metrics
duration: 25min
completed: 2026-04-01
---

# Phase 17 Plan 03: Security Hardening & API Sanity Review Summary

**helmet + CORS deny-all + ThrottlerGuard applied, all 5 API controllers verified against PROTOCOL.md with structured error format enforced**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-01T04:24:00Z
- **Completed:** 2026-04-01T04:49:00Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Applied `helmet()` globally in bootstrap — sets X-Frame-Options, X-Content-Type-Options, HSTS, and other HTTP security headers (D-14)
- Changed CORS from `origin: 'http://localhost:5173'` to `origin: false` — API only receives Postmark webhooks, no browser clients (D-16)
- Added `ThrottlerModule.forRoot` at 100 req/60s in AppModule and `ThrottlerGuard` as outermost guard on POST /webhooks/email (D-15)
- Reviewed all 5 API controllers (webhooks, jobs, candidates, applications, health) against PROTOCOL.md — no tenantId leaks, snake_case throughout, correct HTTP codes, structured errors (D-18, D-19, D-20)
- Fixed 5 plain-string `BadRequestException` calls in candidates.service to use `{ error: { code, message } }` format

## Task Commits

Each task was committed atomically:

1. **Task 1: Apply helmet + CORS deny-all + install throttler** - `2bd243e` (feat)
2. **Task 2: Apply ThrottlerGuard to POST /webhooks/email** - `fc67716` (feat)
3. **Task 3: API endpoint sanity review — verify PROTOCOL.md alignment** - `10a77bb` (feat)

## Files Created/Modified

- `src/main.ts` - Added `import helmet from 'helmet'`; `app.use(helmet())`; changed `enableCors({ origin: false })`
- `src/app.module.ts` - Added `ThrottlerModule` import and `ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }])`
- `src/webhooks/webhooks.controller.ts` - Added `ThrottlerGuard` as outermost guard; wrapped Zod parse in `safeParse` with structured error
- `src/webhooks/webhooks.controller.spec.ts` - Added `ThrottlerModule` to testing module imports
- `src/candidates/candidates.service.ts` - Fixed 4 plain-string `BadRequestException` to use `{ error: { code, message } }` format

## Decisions Made

- **CORS deny-all**: Set `origin: false` rather than keeping the localhost exception. Phase 1 is purely webhook-driven; no browser client hits this API directly. The localhost setting was leftover from early development.
- **ThrottlerGuard before PostmarkAuthGuard**: Rate limiting runs first to prevent brute-force auth attempts from consuming server resources.
- **safeParse on webhook payload**: Changed from `.parse()` (throws raw Zod error) to `.safeParse()` returning `{ error: { code, message, details } }` — consistent with other controllers.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Fixed plain-string BadRequestException in candidates.service**
- **Found during:** Task 3 (API sanity review)
- **Issue:** 4 `BadRequestException` calls in candidates.service used plain strings instead of structured `{ error: { code, message } }` format — violates PROTOCOL.md error contract
- **Fix:** Replaced all 4 with structured objects using error codes: `NO_JOB`, `STAGE_NOT_FOUND`, `LAST_STAGE`
- **Files modified:** `src/candidates/candidates.service.ts`
- **Verification:** Full test suite run, 286 tests pass
- **Committed in:** `10a77bb` (Task 3 commit)

**2. [Rule 2 - Missing Critical] Added ThrottlerModule to controller test module**
- **Found during:** Task 2 (apply ThrottlerGuard)
- **Issue:** After adding `ThrottlerGuard` to webhooks controller, the controller unit test couldn't resolve `ThrottlerGuard` dependency — 2 test failures
- **Fix:** Added `ThrottlerModule.forRoot` import to the test module setup
- **Files modified:** `src/webhooks/webhooks.controller.spec.ts`
- **Verification:** All 24 webhook tests pass
- **Committed in:** `fc67716` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 2 — missing critical correctness)
**Impact on plan:** Both fixes necessary for test correctness and API contract compliance. No scope creep.

## Issues Encountered

- **Pre-existing 4 failing jobs integration tests**: These were failing before this plan (confirmed by `git stash` → test → `git stash pop`). The failures are in `jobs.integration.spec.ts` around `updateJob` candidate detachment logic. Logged as out-of-scope — not caused by this plan's changes and not fixed here.

## Known Stubs

None — all changes are production-quality. No placeholder values or hardcoded stubs introduced.

## Next Phase Readiness

- Security hardening complete: helmet + CORS deny-all + rate limiting all applied
- API contract verified: 5 controllers match PROTOCOL.md, error format consistent
- Ready for Plan 17-04: Docker + nginx + SSL/TLS configuration for Hetzner deployment
- Remaining work: Pre-existing 4 jobs integration test failures should be addressed before production

---
*Phase: 17-production-deployment-readiness-fix-tests-add-sanity-checks-and-prepare-ci-cd-for-hetzner-jenkins*
*Completed: 2026-04-01*
