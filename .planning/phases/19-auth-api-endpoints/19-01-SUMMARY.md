---
phase: 19-auth-api-endpoints
plan: "01"
subsystem: auth
tags: [schema, session-guard, email-service, cookie-parser, test-stubs]
dependency_graph:
  requires: [phase-18-jwt-service]
  provides: [SessionGuard, EmailService, onboarding_completed_at-column, Wave0-test-stubs]
  affects: [auth.module, main.ts, prisma-schema]
tech_stack:
  added: [nodemailer, cookie-parser, "@types/nodemailer", "@types/cookie-parser"]
  patterns: [NestJS-injectable-guard, CanActivate, nodemailer-transport, Zod-env-extension]
key_files:
  created:
    - prisma/migrations/20260411000000_add_onboarding_completed_at/migration.sql
    - src/auth/session.guard.ts
    - src/auth/email.service.ts
    - src/auth/session.guard.spec.ts
    - src/auth/email.service.spec.ts
    - src/auth/auth.controller.spec.ts
  modified:
    - prisma/schema.prisma
    - src/config/env.ts
    - src/auth/auth.module.ts
    - src/main.ts
    - .env.example
    - docker-compose.yml
decisions:
  - "SessionGuard uses require('cookie-parser') instead of import * as due to TypeScript namespace-import restriction"
  - "Migration file created manually since Docker DB was not running during execution"
  - "cookie-parser middleware placed after helmet() to match plan D-16 spec"
metrics:
  duration_minutes: 3
  completed_date: "2026-04-11"
  tasks_completed: 3
  tasks_total: 3
  files_created: 6
  files_modified: 6
---

# Phase 19 Plan 01: Foundation — Schema, SessionGuard, EmailService, Wave 0 Stubs Summary

JWT-cookie auth foundation: onboarding_completed_at migration, SessionGuard reading talent_os_session cookie, EmailService with dev-console fallback, CORS + cookie-parser in main.ts, and 23 Wave 0 test stubs across 3 spec files.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Schema migration — add onboardingCompletedAt | 1ff6cfc | prisma/schema.prisma, migrations/20260411000000_add_onboarding_completed_at/ |
| 2 | Env schema extension + dependencies + EmailService | 39a6033 | src/config/env.ts, src/auth/email.service.ts, .env.example, docker-compose.yml |
| 3 | SessionGuard + main.ts updates + auth.module.ts + Wave 0 stubs | 31d855f | src/auth/session.guard.ts, auth.module.ts, main.ts, 3 spec files |

## What Was Built

**Schema:** Added nullable `onboarding_completed_at` Timestamptz column to `tenants` table. Created migration SQL file manually (Docker not running during execution). Additive only — no existing data risk.

**EmailService** (`src/auth/email.service.ts`): NestJS injectable with three methods — `sendInvitationEmail`, `sendMagicLinkEmail`, `sendUseGoogleEmail`. Uses Nodemailer for real SMTP; falls back to console logging when `SMTP_HOST` is absent (D-12 dev fallback).

**Env schema** (`src/config/env.ts`): Extended Zod schema with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `FRONTEND_URL`, `GOOGLE_CLIENT_ID`.

**SessionGuard** (`src/auth/session.guard.ts`): Implements `CanActivate`. Reads `talent_os_session` cookie, calls `JwtService.verify()`, attaches decoded `JwtPayload` to `request.session`. Throws `UnauthorizedException` if cookie absent or JWT invalid/expired.

**auth.module.ts**: Providers and exports updated to `[JwtService, SessionGuard, EmailService]`.

**main.ts**: Added `require('cookie-parser')` middleware after `helmet()`. Updated CORS to use `FRONTEND_URL` env var with `credentials: true`.

**Wave 0 test stubs**: 23 `it.todo` entries across 3 spec files — ready for Plans 02/03/04 to implement.

## Test Results

- 287 existing tests: all passing
- 23 new stubs: all `it.todo` (correct for Wave 0)
- 24 test suites total

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TypeScript namespace import error for cookie-parser**
- **Found during:** Task 3 build verification
- **Issue:** `import * as cookieParser from 'cookie-parser'` fails TypeScript check: "A namespace-style import cannot be called or constructed"
- **Fix:** Replaced with `const cookieParser = require('cookie-parser')` using `// eslint-disable-next-line` comment
- **Files modified:** src/main.ts
- **Commit:** 31d855f

**2. [Rule 3 - Blocking] Docker not running — cannot run `prisma migrate dev`**
- **Found during:** Task 1 migration step
- **Issue:** Containers not running, `prisma migrate dev` requires live DB connection
- **Fix:** Created migration file manually using `mkdir + Write tool` with correct SQL: `ALTER TABLE "tenants" ADD COLUMN "onboarding_completed_at" TIMESTAMPTZ`
- **Files modified:** prisma/migrations/20260411000000_add_onboarding_completed_at/migration.sql
- **Commit:** 1ff6cfc

**3. [Operational] Planning files accidentally removed in Task 1 commit**
- **Found during:** Task 1 commit (git reset --soft staged diff included planning file removals)
- **Fix:** Restored all 7 planning files from base commit (162f5b2) in a cleanup commit
- **Commit:** 3c036dc

## Known Stubs

None — all code is fully implemented. Wave 0 test stubs are intentional `it.todo` entries per the plan's Nyquist requirement.

## Threat Surface Scan

No new network endpoints or auth paths introduced in this plan. SessionGuard and EmailService are infrastructure components; they are consumed by endpoints in Plans 02–04. The threat register in the plan covers T-19-01 through T-19-04 — all mitigations are applied:
- T-19-01 (cookie spoofing): cookie parsing now wired; `httpOnly`/`sameSite` set in Plan 02 when cookie is written
- T-19-02 (JWT forgery): `JwtService.verify()` uses jose cryptographic verification
- T-19-03 (SMTP credentials): env vars only, never in source
- T-19-04 (privilege escalation): payload attached only after `jwtVerify()` succeeds

## Self-Check: PASSED

Files created:
- prisma/migrations/20260411000000_add_onboarding_completed_at/migration.sql — FOUND
- src/auth/session.guard.ts — FOUND
- src/auth/email.service.ts — FOUND
- src/auth/session.guard.spec.ts — FOUND
- src/auth/email.service.spec.ts — FOUND
- src/auth/auth.controller.spec.ts — FOUND

Commits:
- 1ff6cfc — FOUND
- 39a6033 — FOUND
- 31d855f — FOUND
