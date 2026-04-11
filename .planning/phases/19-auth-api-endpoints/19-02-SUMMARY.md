---
phase: 19-auth-api-endpoints
plan: "02"
subsystem: auth
tags: [auth-service, auth-controller, google-oauth, session-cookie, get-me, logout]
dependency_graph:
  requires: [19-01-SessionGuard, 18-JwtService, prisma-Organization-User-models]
  provides: [AuthService, AuthController, GET-auth-me, POST-auth-google-verify, POST-auth-logout, MeResponse]
  affects: [auth.module, src/auth/auth.service.ts, src/auth/auth.controller.ts]
tech_stack:
  added: []
  patterns: [NestJS-passthrough-Res, prisma.$transaction-callback, dev-stub-JSON-token, ConflictException-error-code]
key_files:
  created:
    - src/auth/auth.service.ts
    - src/auth/auth.service.spec.ts
    - src/auth/auth.controller.ts
  modified:
    - src/auth/auth.module.ts
decisions:
  - "Express Response imported as namespace (import * as express) to avoid TS1272 decorator metadata error with isolatedModules"
  - "nodemailer npm install required in main repo (was in package.json from Plan 01 but not installed)"
  - "Dev stub: tries base64-decoded JSON first, then plain JSON — handles both encoding styles"
metrics:
  duration_minutes: 15
  completed_date: "2026-04-11"
  tasks_completed: 2
  tasks_total: 2
  files_created: 3
  files_modified: 1
---

# Phase 19 Plan 02: AuthService + AuthController — GET /auth/me, POST /auth/google/verify, POST /auth/logout Summary

Three-endpoint auth core: Google OAuth sign-up/sign-in with DB transaction, HTTP-only 7-day session cookie, GET /auth/me with SessionGuard, and logout — all wired into AuthModule.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | AuthService with googleVerify, getMe, buildMeResponse + 7 tests | 4ecbb0a | src/auth/auth.service.ts, src/auth/auth.service.spec.ts |
| 2 | AuthController (3 endpoints) + auth.module.ts update | 53b0ce3 | src/auth/auth.controller.ts, src/auth/auth.module.ts |

## What Was Built

**AuthService** (`src/auth/auth.service.ts`):
- `googleVerify(accessToken)`: Dev stub (JSON parse) or production Google UserInfo API call. For new emails: creates Organization + User in `prisma.$transaction` (3-step sequence: create org → create user → update org.createdByUserId). For returning Google users: issues new session. For email registered with different auth_provider: throws `ConflictException({ code: 'EMAIL_EXISTS' })`.
- `getMe(session)`: Loads User + Organization from DB, returns MeResponse shape.
- `buildMeResponse()`: Derives `has_completed_onboarding` from `org.onboardingCompletedAt != null`.
- `MeResponse` interface exported for use by other plans.

**AuthController** (`src/auth/auth.controller.ts`):
- `GET /auth/me`: Protected by `@UseGuards(SessionGuard)` — 401 if no/invalid cookie.
- `POST /auth/google/verify`: Public endpoint. Sets `talent_os_session` HTTP-only cookie (7d, sameSite:lax, secure in production). Returns MeResponse.
- `POST /auth/logout`: Public endpoint. Clears `talent_os_session` cookie. Returns `{ success: true }`.

**auth.module.ts**: Added `AuthController` to `controllers`, `AuthService` to `providers`. PrismaModule is `@Global()` — not imported here.

## Test Results

- 7 new unit tests for AuthService: all passing
- 294 tests total across 25 suites: all passing
- 23 todo stubs (Wave 0 from Plan 01): unchanged

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TypeScript TS1272 error: Response type in decorated signature**
- **Found during:** Task 2 build verification
- **Issue:** `import { Response } from 'express'` causes TS1272 — "A type referenced in a decorated signature must be imported with 'import type' or a namespace import when 'isolatedModules' and 'emitDecoratorMetadata' are enabled."
- **Fix:** Changed to `import * as express from 'express'` and typed parameters as `express.Response`. Added `import type { Request }` for the non-decorated parameter.
- **Files modified:** src/auth/auth.controller.ts
- **Commit:** 53b0ce3

**2. [Rule 3 - Blocking] nodemailer not installed (only in package.json)**
- **Found during:** Task 2 build verification
- **Issue:** Plan 01 added nodemailer to package.json but `npm install` was not run in the main repo. Build failed: "Cannot find module 'nodemailer'"
- **Fix:** Ran `npm install` in the main repo — installed all packages from package.json including nodemailer and @types/nodemailer
- **Files modified:** none (node_modules only)
- **Commit:** none (node_modules not committed)

## Known Stubs

None — all three endpoints are fully implemented. The `auth.controller.spec.ts` Wave 0 stubs (14 `it.todo` entries) are intentional placeholders from Plan 01 for Plans 02-04 to implement. Tests 1-5 of Plan 02's spec (auth.service.spec.ts) are now green.

## Threat Surface Scan

New network endpoints introduced:
- `GET /auth/me` — protected by SessionGuard (T-19-08 mitigated)
- `POST /auth/google/verify` — public; validates Google token server-side (T-19-06 mitigated); dev stub gated by NODE_ENV (T-19-05 mitigated)
- `POST /auth/logout` — public; only clears cookie (no sensitive data returned)

Cookie: httpOnly + sameSite:lax + secure:production (T-19-07 mitigated)
Role assignment: hardcoded `role: 'owner'` for new users (T-19-09 mitigated)

No new threat surface beyond what the plan's threat model already covers.

## Self-Check: PASSED

Files created:
- src/auth/auth.service.ts — FOUND
- src/auth/auth.service.spec.ts — FOUND
- src/auth/auth.controller.ts — FOUND

Commits:
- 4ecbb0a — FOUND
- 53b0ce3 — FOUND
