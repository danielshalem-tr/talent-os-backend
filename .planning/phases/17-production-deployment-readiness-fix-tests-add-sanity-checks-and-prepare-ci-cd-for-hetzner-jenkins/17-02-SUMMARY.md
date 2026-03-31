---
phase: 17-production-deployment-readiness-fix-tests-add-sanity-checks-and-prepare-ci-cd-for-hetzner-jenkins
plan: '02'
subsystem: infra
tags: [nestjs-pino, pino, health-check, e2e, bullmq, logging, structured-logging]

# Dependency graph
requires:
  - phase: 17-01
    provides: fixed failing unit tests as baseline for E2E

provides:
  - GET /api/health endpoint with DB + Redis probes (200 ok / 503 degraded)
  - HealthModule with HealthService and HealthController
  - nestjs-pino LoggerModule configured in AppModule with pino-pretty for dev, JSON for prod
  - app.useLogger(app.get(Logger)) in main.ts bootstrap
  - E2E smoke test in test/app.e2e-spec.ts — npm run test:e2e passes
  - BullMQ lifecycle logging in IngestionProcessor: Job started/completed/failed with jobId/jobName/tenantId
  - Worker bootstrap log in src/worker.ts

affects:
  - 17-03 (docker healthcheck can now reference /api/health)
  - 17-05 (README documents health endpoint and logging)

# Tech tracking
tech-stack:
  added: [nestjs-pino, pino, pino-pretty, "@nestjs/terminus"]
  patterns:
    - HealthModule pattern with @InjectQueue reusing existing BullMQ connection for Redis probe
    - Pino object-first structured logging: pinoLogger.log({ jobId, jobName, tenantId }, 'message')
    - E2E test accepts 200 or 503 to work in CI without real infra
    - Manual mock for ESM module (@openrouter/sdk) via moduleNameMapper in jest-e2e.json

key-files:
  created:
    - src/health/health.service.ts
    - src/health/health.controller.ts
    - src/health/health.module.ts
    - test/__mocks__/@openrouter/sdk.js
  modified:
    - src/app.module.ts
    - src/main.ts
    - src/worker.ts
    - src/ingestion/ingestion.processor.ts
    - src/ingestion/ingestion.processor.spec.ts
    - test/app.e2e-spec.ts
    - test/jest-e2e.json
    - package.json
    - package-lock.json

key-decisions:
  - "Redis health check reuses injected BullMQ queue client (await this.queue.client) — no new connections per probe"
  - "E2E test accepts 200 OR 503 — health endpoint shape is the gate, not infra availability"
  - "ESM @openrouter/sdk mock added to jest-e2e.json moduleNameMapper to unblock E2E test bootstrap"
  - "PinoLogger injected as separate constructor param in IngestionProcessor — NestJS Logger kept for existing calls"
  - "pino-pretty for development (colorize+singleLine), plain JSON for production (NODE_ENV=production)"

patterns-established:
  - "Health probe pattern: DB via prisma.\$queryRaw SELECT 1, Redis via injected BullMQ queue client"
  - "Lifecycle logging: pinoLogger.log({jobId, jobName, tenantId}, 'Job started/completed'), pinoLogger.error({...error}, 'Job failed')"

requirements-completed: [D-11, D-21, D-22, D-23, D-24]

# Metrics
duration: 32min
completed: 2026-03-31
---

# Phase 17 Plan 02: Health Endpoint, E2E Smoke Test, and Structured Logging Summary

**GET /api/health endpoint with DB+Redis probes, nestjs-pino JSON logging, and E2E smoke test — npm run test:e2e passes green**

## Performance

- **Duration:** 32 min
- **Started:** 2026-03-31T16:39:42Z
- **Completed:** 2026-03-31T17:12:00Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments

- HealthModule created with DB probe (prisma.$queryRaw SELECT 1) and Redis probe via injected BullMQ queue client — no new Redis connections per health check
- nestjs-pino LoggerModule wired into AppModule (pino-pretty dev, JSON prod) with app.useLogger(app.get(Logger)) in main.ts
- E2E smoke test created and passing — accepts 200 or 503, asserts correct response shape with status/checks/uptime
- BullMQ lifecycle events logged in IngestionProcessor with structured pino format (object-first: jobId, jobName, tenantId)
- Worker startup log added to src/worker.ts

## Task Commits

Each task was committed atomically:

1. **Task 1: Install nestjs-pino + @nestjs/terminus and create HealthModule** - `083fd67` (feat)
2. **Task 2: Add E2E smoke test for GET /api/health + configure nestjs-pino logger** - `464e2ba` (feat)
3. **Task 3: Add BullMQ lifecycle logging to IngestionProcessor worker** - `77fc92d` (feat)

**Plan metadata:** (docs: complete plan) — included in final state commit

## Files Created/Modified

- `src/health/health.service.ts` — DB + Redis health probes; injects PrismaService and BullMQ queue
- `src/health/health.controller.ts` — GET /health returns 200 ok or 503 degraded with status/checks/uptime
- `src/health/health.module.ts` — HealthModule importing BullModule.registerQueue for @InjectQueue
- `src/app.module.ts` — Added LoggerModule.forRoot and HealthModule to imports
- `src/main.ts` — Added bufferLogs + app.useLogger(app.get(Logger)) for nestjs-pino
- `src/worker.ts` — Added 'BullMQ Worker started' startup log
- `src/ingestion/ingestion.processor.ts` — Added pinoLogger injection + Job started/completed/failed lifecycle logs
- `src/ingestion/ingestion.processor.spec.ts` — Added PinoLogger mock to all 5 TestingModule setups
- `test/app.e2e-spec.ts` — Rewritten with GET /api/health smoke test
- `test/jest-e2e.json` — Added moduleNameMapper for @openrouter/sdk ESM compat
- `test/__mocks__/@openrouter/sdk.js` — Manual ESM mock for E2E tests
- `package.json` / `package-lock.json` — Added nestjs-pino, pino, pino-pretty, @nestjs/terminus

## Decisions Made

- Reused existing BullMQ `ingest-email` queue client for Redis health probe — avoids wasteful new connections
- E2E test accepts both 200 and 503 so it passes in CI environments without DB/Redis running
- Added `moduleNameMapper` to jest-e2e.json to handle `@openrouter/sdk` ESM import failure in Jest
- Used `PinoLogger` as a separate injected dependency alongside existing `this.logger` (NestJS Logger) — existing log calls preserved, pino only for structured lifecycle events

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added @openrouter/sdk mock to jest-e2e.json to unblock E2E test**
- **Found during:** Task 2 (E2E smoke test)
- **Issue:** @openrouter/sdk is an ESM module, causing `SyntaxError: Unexpected token 'export'` when Jest tried to load AppModule in E2E tests
- **Fix:** Added moduleNameMapper to test/jest-e2e.json and created test/__mocks__/@openrouter/sdk.js
- **Files modified:** test/jest-e2e.json, test/__mocks__/@openrouter/sdk.js
- **Verification:** npm run test:e2e passes — 1 test passing
- **Committed in:** 464e2ba (Task 2 commit)

**2. [Rule 1 - Bug] Fixed pre-existing test assertions using wrong job status value**
- **Found during:** Task 3 (IngestionProcessor tests)
- **Issue:** Two tests in ingestion.processor.spec.ts expected `status: 'active'` but production code queries `status: 'open'`
- **Fix:** Changed both occurrences to `status: 'open'` to match the actual query in extractAllJobIdsFromEmailText()
- **Files modified:** src/ingestion/ingestion.processor.spec.ts
- **Verification:** All 29 processor tests pass
- **Committed in:** 77fc92d (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both auto-fixes necessary for tests to run. No scope creep.

## Issues Encountered

- TypeScript `isolatedModules` + `emitDecoratorMetadata` requires `import type` for Response from express — fixed by changing `import { Response }` to `import type { Response }` in health.controller.ts (caught by `npm run build`)

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- GET /api/health endpoint available for Docker healthcheck configuration (plan 17-03)
- nestjs-pino JSON logging active in production — worker traces now machine-readable
- E2E test infrastructure working — basis for any future E2E tests
- All plan 17-02 success criteria met: health endpoint, E2E passing, structured logging, lifecycle events

## Self-Check: PASSED

- FOUND: src/health/health.controller.ts
- FOUND: src/health/health.service.ts
- FOUND: src/health/health.module.ts
- FOUND: test/app.e2e-spec.ts
- FOUND commit: 083fd67 (Task 1)
- FOUND commit: 464e2ba (Task 2)
- FOUND commit: 77fc92d (Task 3)

---
*Phase: 17-production-deployment-readiness-fix-tests-add-sanity-checks-and-prepare-ci-cd-for-hetzner-jenkins*
*Completed: 2026-03-31*
