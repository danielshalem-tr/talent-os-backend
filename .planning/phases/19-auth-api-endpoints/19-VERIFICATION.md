---
phase: 19-auth-api-endpoints
verified: 2026-04-11T00:00:00Z
status: human_needed
score: 15/16 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Start the API container and issue POST /auth/google/verify with a dev stub token (JSON {email, name}). Confirm 200 response includes all 9 MeResponse fields and the talent_os_session cookie is set as httpOnly."
    expected: "HTTP 200 with { id, name, email, role, org_id, org_name, org_logo_url, auth_provider, has_completed_onboarding }; Set-Cookie header with talent_os_session, HttpOnly, SameSite=Lax"
    why_human: "Requires a running Docker stack with live DB; can't verify cookie shape or DB transaction outcome from static analysis alone."
  - test: "Call POST /auth/google/verify with the same email a second time. Confirm the cookie is refreshed and no duplicate org/user is created."
    expected: "HTTP 200, same user id/org_id returned, no new rows in organizations or users tables."
    why_human: "Requires running DB and live endpoint to confirm idempotency of returning-user path."
  - test: "Call GET /auth/magic-link/verify with an expired token (TTL already elapsed in Redis). Confirm it returns 404, not 500."
    expected: "HTTP 404 { error: { code: 'NOT_FOUND', message: 'Invalid or expired magic link' } }"
    why_human: "Requires Redis TTL expiry — needs either a real Redis instance or waiting for TTL; cannot assert at static analysis time."
  - test: "Call POST /auth/team/invitations as a non-owner session. Confirm 403 is returned before any DB write."
    expected: "HTTP 403 ForbiddenException; no invitation row created."
    why_human: "Requires a live session with role !== 'owner' and DB inspection to confirm no row was written."
---

# Phase 19: Auth API Endpoints Verification Report

**Phase Goal:** Implement all Auth API endpoints from PROTOCOL.md section 7 — session management via HTTP-only cookies, Google OAuth verification, magic link login, invitation flow, and team management.
**Verified:** 2026-04-11
**Status:** human_needed (all automated checks pass; 4 behavioral tests require a running stack)
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `GET /auth/me` returns 401 when no session cookie | VERIFIED | `@UseGuards(SessionGuard)` on `getMe()` in auth.controller.ts line 37; SessionGuard throws UnauthorizedException when cookie absent (session.guard.ts line 19) |
| 2 | `GET /auth/me` returns MeResponse for valid session | VERIFIED | `getMe()` delegates to `authService.getMe(session)` which loads User + Org and calls `buildMeResponse()` returning all 9 required fields |
| 3 | `POST /auth/google/verify` creates Org+User in DB transaction on first sign-up | VERIFIED | `prisma.$transaction` at auth.service.ts line 95; 3-step sequence: create org, create user, update org.createdByUserId |
| 4 | `POST /auth/google/verify` returns 409 EMAIL_EXISTS for mismatched auth_provider | VERIFIED | `throw new ConflictException({ code: 'EMAIL_EXISTS' })` at auth.service.ts line 77-79 |
| 5 | `POST /auth/google/verify` sets httpOnly 7-day talent_os_session cookie | VERIFIED | `setSessionCookie()` helper in auth.controller.ts: httpOnly:true, sameSite:'lax', maxAge:7d, secure in production |
| 6 | `POST /auth/logout` clears talent_os_session cookie and returns { success: true } | VERIFIED | `res.clearCookie(SESSION_COOKIE, { path: '/' })` + `return { success: true }` in auth.controller.ts lines 62-64 |
| 7 | `POST /auth/onboarding` sets org.onboardingCompletedAt and returns { success: true } | VERIFIED | `completeOnboarding()` in auth.service.ts updates org with `onboardingCompletedAt: new Date()`; returns `{ success: true }` |
| 8 | `POST /auth/onboarding` returns 409 when already completed | VERIFIED | `if (org.onboardingCompletedAt != null) throw new ConflictException({ code: 'ONBOARDING_COMPLETE' })` at auth.service.ts line 175 |
| 9 | `POST /auth/magic-link` always returns 200 (no email enumeration) | VERIFIED | Handler returns `{ success: true }` unconditionally regardless of email lookup result (auth.controller.ts line 89) |
| 10 | `GET /auth/magic-link/verify` sets cookie and redirects on valid token | VERIFIED | `invitationService.verifyMagicLink(token)` → session cookie set → `res.redirect('/')` in auth.controller.ts lines 108-120 |
| 11 | `GET /auth/invite/:token` returns { org_name, role, email } or 404/409/410 | VERIFIED | `validateInvite()` in invitation.service.ts throws NotFoundException/ConflictException/GoneException per state; returns correct shape |
| 12 | `POST /auth/invite/:token/accept` creates user, marks accepted, sets session cookie | VERIFIED | `acceptInvite()` runs `prisma.$transaction` creating user + updating invitation.status='accepted'; cookie set in controller |
| 13 | Magic link tokens stored in Redis as `ml:{token}` with TTL 3600s (one-time use) | VERIFIED | `redis.set(redisKey, user.id, 'EX', 3600)` and `redis.del(redisKey)` in invitation.service.ts lines 44 and 58 |
| 14 | All 6 team endpoints require SessionGuard | VERIFIED | `@UseGuards(SessionGuard)` at controller class level in team.controller.ts line 20 |
| 15 | Team RBAC: role changes and member removal are Owner-only | VERIFIED | Inline ForbiddenException guards at method entry in team.service.ts: changeRole checks role!=='owner', removeMember checks role!=='owner', self-target, and targeting owner |
| 16 | Google OAuth dev stub active when GOOGLE_CLIENT_ID absent | UNCERTAIN | Code path present (`if (!clientId \|\| !isProd)` in auth.service.ts), but dev stub behavior (base64-decode then plain JSON) requires live execution to confirm the token parsing chain works end-to-end |

**Score: 15/16 truths verified** (SC-16 is uncertain — needs human spot-check, covered under behavioral tests)

---

### Per-Plan Completion Status

| Plan | Goal | Status | Evidence |
|------|------|--------|----------|
| 19-01 | Schema migration, SessionGuard, EmailService, Wave 0 stubs | COMPLETE | All 6 artifacts exist, build clean, 23 todo stubs confirmed |
| 19-02 | GET /auth/me, POST /auth/google/verify, POST /auth/logout | COMPLETE | Endpoints verified in controller; AuthService tests pass (7 tests) |
| 19-03 | Onboarding, magic link, invitation acceptance | COMPLETE | 5 endpoints verified in controller; InvitationService tests pass (8 tests) |
| 19-04 | Team management (6 endpoints) | COMPLETE | TeamController with class-level guard; TeamService tests pass (11 tests) |

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `prisma/migrations/20260411000000_add_onboarding_completed_at/migration.sql` | onboarding_completed_at column | VERIFIED | SQL: `ALTER TABLE "tenants" ADD COLUMN "onboarding_completed_at" TIMESTAMPTZ` |
| `prisma/schema.prisma` | onboardingCompletedAt field in Organization | VERIFIED | Line 20: `onboardingCompletedAt DateTime? @map("onboarding_completed_at") @db.Timestamptz` |
| `src/config/env.ts` | SMTP_* + FRONTEND_URL + GOOGLE_CLIENT_ID fields | VERIFIED | Lines 17-23: all 7 new fields present |
| `src/auth/session.guard.ts` | SessionGuard CanActivate | VERIFIED | Exports SessionGuard, reads talent_os_session cookie, calls jwtService.verify(), throws UnauthorizedException |
| `src/auth/email.service.ts` | EmailService with 3 send methods + dev fallback | VERIFIED | sendInvitationEmail, sendMagicLinkEmail, sendUseGoogleEmail all present; dev fallback on line 32 |
| `src/auth/auth.module.ts` | All providers + controllers wired | VERIFIED | controllers: [AuthController, TeamController]; providers: 6 services; exports: 3 |
| `src/main.ts` | cookieParser middleware + credentials CORS | VERIFIED | cookieParser() on line 24; credentials:true on line 35 |
| `src/auth/session.guard.spec.ts` | 4 it.todo stubs | VERIFIED | 4 todo stubs confirmed |
| `src/auth/email.service.spec.ts` | 5 it.todo stubs | VERIFIED | 5 todo stubs confirmed |
| `src/auth/auth.controller.spec.ts` | 14 it.todo stubs | VERIFIED | 14 todo stubs confirmed |
| `src/auth/auth.service.ts` | AuthService + MeResponse | VERIFIED | googleVerify, getMe, buildMeResponse, completeOnboarding all present |
| `src/auth/auth.service.spec.ts` | Unit tests for AuthService | VERIFIED | 7 passing tests (from summary) |
| `src/auth/auth.controller.ts` | 8 auth endpoints | VERIFIED | GET /auth/me, POST /auth/google/verify, POST /auth/logout, POST /auth/onboarding, POST /auth/magic-link, GET /auth/magic-link/verify, GET /auth/invite/:token, POST /auth/invite/:token/accept |
| `src/auth/invitation.service.ts` | InvitationService | VERIFIED | validateInvite, acceptInvite, generateAndStoreMagicLink, verifyMagicLink all present |
| `src/auth/invitation.service.spec.ts` | 8 tests | VERIFIED | 8 passing tests (from summary) |
| `src/auth/team.service.ts` | TeamService with 6 methods | VERIFIED | getMembers, getInvitations, createInvitation, cancelInvitation, changeRole, removeMember all present |
| `src/auth/team.service.spec.ts` | 11 tests | VERIFIED | 11 passing tests (from summary) |
| `src/auth/team.controller.ts` | TeamController with 6 endpoints + class-level guard | VERIFIED | @UseGuards(SessionGuard) at class level; all 6 endpoints with correct HTTP codes |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `session.guard.ts` | `jwt.service.ts` | `jwtService.verify(token)` | WIRED | Pattern `jwtService.verify` found in session.guard.ts line 20 |
| `main.ts` | `cookie-parser` | `app.use(cookieParser())` | WIRED | `cookieParser` found in main.ts lines 6 and 24 |
| `auth.controller.ts` | `auth.service.ts` | constructor injection | WIRED | `authService.getMe`, `authService.googleVerify`, `authService.completeOnboarding` all called |
| `auth.service.ts` | `prisma.$transaction` | org + user creation | WIRED | `prisma.$transaction` confirmed at auth.service.ts line 95 |
| `auth.controller.ts` | `res.cookie('talent_os_session')` | `@Res({ passthrough: true })` | WIRED | `setSessionCookie()` helper called; httpOnly:true present |
| `invitation.service.ts` | Redis (ioredis) | `redis.set/get/del` | WIRED | All three Redis operations confirmed in invitation.service.ts |
| `auth.controller.ts` | `invitation.service.ts` | constructor injection | WIRED | `invitationService.generateAndStoreMagicLink`, `invitationService.verifyMagicLink`, `invitationService.validateInvite`, `invitationService.acceptInvite` all called |
| `team.controller.ts` | `session.guard.ts` | `@UseGuards(SessionGuard)` at class level | WIRED | Class-level decorator confirmed at team.controller.ts line 20 |
| `team.service.ts` | `email.service.ts` | `emailService.sendInvitationEmail()` | WIRED | Called at team.service.ts line 106 |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| `auth.controller.ts` GET /auth/me | `MeResponse` | `authService.getMe(session)` → `prisma.user.findUniqueOrThrow` + `prisma.organization.findUniqueOrThrow` | Yes — real DB queries | FLOWING |
| `auth.service.ts` googleVerify | `result.user/org` | `prisma.$transaction` creates real rows | Yes — real DB writes | FLOWING |
| `team.service.ts` getMembers | `users` | `prisma.user.findMany({ where: { organizationId, isActive: true } })` | Yes — real DB query | FLOWING |
| `team.service.ts` getInvitations | `invitations` | `prisma.invitation.findMany({ where: { organizationId, status: 'pending', expiresAt: { gt: new Date() } } })` | Yes — real DB query | FLOWING |
| `invitation.service.ts` verifyMagicLink | `userId` | `redis.get(redisKey)` | Yes — real Redis read | FLOWING |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Build compiles without TypeScript errors | `npm run build` | Exit 0, no errors | PASS |
| Full test suite | `npm test` | 313 passed, 23 todo, 0 failed, 27 suites | PASS |
| SessionGuard reads talent_os_session cookie | grep session.guard.ts | `request.cookies?.['talent_os_session']` confirmed | PASS |
| Magic link endpoint always returns 200 | grep auth.controller.ts | Unconditional `return { success: true }` after optional email check | PASS |
| TeamController class-level SessionGuard | grep team.controller.ts | `@UseGuards(SessionGuard)` at line 20 (class level) | PASS |
| Google verify + invite accept + magic link verify — live behavior | Requires running stack | Not verified statically | SKIP |

---

### Requirements Coverage

| Requirement | Plans | Description | Status | Evidence |
|-------------|-------|-------------|--------|----------|
| AUTH-001 | 19-01, 19-02 | Session management (SessionGuard, GET /auth/me, cookie lifecycle) | SATISFIED | SessionGuard, httpOnly cookie, GET /auth/me all implemented |
| AUTH-002 | 19-03 | Onboarding completion | SATISFIED | POST /auth/onboarding with duplicate guard |
| AUTH-003 | 19-03, 19-04 | Invitation flow | SATISFIED | GET /auth/invite/:token, POST /auth/invite/:token/accept, POST /auth/team/invitations |
| AUTH-004 | 19-03 | Invitation validation states | SATISFIED | 404/409/410 states in validateInvite() |
| AUTH-005 | 19-01, 19-03 | Magic link login | SATISFIED | EmailService, POST /auth/magic-link, GET /auth/magic-link/verify with Redis TTL |
| AUTH-006 | 19-01, 19-02, 19-04 | Role-based access | SATISFIED | Owner-only guards on changeRole, removeMember, createInvitation |
| AUTH-007 | 19-04 | Team member management | SATISFIED | All 6 team endpoints: view/invite/cancel/change-role/remove |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/auth/auth.service.ts` | ~180 | `logoUrl = key; // placeholder until StorageService injection added` comment in plan, but actual code injects StorageService properly | INFO | Non-issue: code correctly uploads to R2 via StorageService; comment in plan was pre-implementation note |
| `src/auth/team.service.ts` | 106 | `console.error('[TeamService] Failed to send invitation email:', err)` | INFO | Intentional non-blocking email failure per threat model T-19-17; invitation record still created |

No blocking anti-patterns found.

---

### Human Verification Required

#### 1. Google OAuth Dev Stub End-to-End

**Test:** POST /auth/google/verify with body `{ "access_token": "{\"email\":\"test@example.com\",\"name\":\"Test User\"}" }` (plain JSON string) against the running API.
**Expected:** HTTP 200, response contains all 9 MeResponse fields, Set-Cookie header with talent_os_session as httpOnly SameSite=Lax. A new organization and user row exist in the DB.
**Why human:** Requires running Docker stack with live PostgreSQL. The dev stub has a base64-then-plain-JSON fallback chain in auth.service.ts that can only be confirmed to work correctly via live execution.

#### 2. Returning User Path (No Duplicate Org)

**Test:** Call POST /auth/google/verify with the same email a second time (after the first call from test 1).
**Expected:** HTTP 200, same `id` and `org_id` returned as first call. No new rows in organizations or users tables.
**Why human:** Requires DB inspection to confirm exactly one user/org row exists after two sign-in calls.

#### 3. Magic Link Token Expiry Behavior

**Test:** Store a magic link token in Redis with TTL of 3 seconds. Wait for expiry. Call GET /auth/magic-link/verify?token={token}.
**Expected:** HTTP 404 `{ error: { code: 'NOT_FOUND', message: 'Invalid or expired magic link' } }` — not 500 or 410.
**Why human:** Requires live Redis with TTL elapsed; cannot simulate at static analysis time. The code returns null for missing keys but the 410/404 distinction for expired tokens (vs never-existed tokens) relies on Redis TTL making the key disappear, which is noted in code comments but needs live confirmation.

#### 4. Team Role Enforcement Live Check

**Test:** Authenticate as a non-owner user (role='member'). Call PATCH /auth/team/members/:id/role with `{ "role": "admin" }`.
**Expected:** HTTP 403 ForbiddenException before any DB write. Confirm no role update occurred in DB.
**Why human:** Requires a live session token with role='member' injected into a valid JWT. Static analysis confirms the guard code exists but cannot verify the JWT payload is correctly read at runtime.

---

### Gaps Summary

No hard gaps found. All 14 auth endpoints are implemented and wired. The 313 passing tests (27 suites) include 7 AuthService tests, 8 InvitationService tests, and 11 TeamService tests — all green. The 4 human verification items are behavioral confirmation tests that require a running stack, not missing implementation.

The one uncertain truth (SC-16: Google OAuth dev stub) has code present and is covered by human test #1 above.

---

_Verified: 2026-04-11_
_Verifier: Claude (gsd-verifier)_
