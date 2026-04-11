---
phase: 19-auth-api-endpoints
plan: "04"
subsystem: auth
tags: [team-management, team-controller, team-service, rbac, invitation-management, soft-delete]
dependency_graph:
  requires: [19-01-SessionGuard, 19-02-AuthService, 19-03-InvitationService, prisma-User-Invitation-models]
  provides: [TeamController, TeamService, GET-auth-team-members, GET-auth-team-invitations, POST-auth-team-invitations, DELETE-auth-team-invitations-id, PATCH-auth-team-members-id-role, DELETE-auth-team-members-id]
  affects: [auth.module]
tech_stack:
  added: []
  patterns: [inline-RBAC-owner-check, soft-delete-isActive-false, non-blocking-email-try-catch, NestJS-class-level-UseGuards]
key_files:
  created:
    - src/auth/team.service.ts
    - src/auth/team.service.spec.ts
    - src/auth/team.controller.ts
  modified:
    - src/auth/auth.module.ts
decisions:
  - "Role enforcement is inline in TeamService (not a separate guard) per D-18 — checks session.role at method entry before any DB query"
  - "Email send failure in createInvitation is non-blocking — invitation record created, email error logged but not propagated to caller"
  - "removeMember uses soft-delete (isActive: false) not hard delete — immediately revokes session access on next request"
  - "import type { JwtPayload } used in team.controller.ts to avoid TS1272 isolatedModules decorator metadata error"
metrics:
  duration_minutes: 8
  completed_date: "2026-04-11"
  tasks_completed: 2
  tasks_total: 2
  files_created: 3
  files_modified: 1
---

# Phase 19 Plan 04: Team Management Endpoints Summary

TeamService + TeamController implementing all 6 team management endpoints — view members, view invitations, send invitations (with duplicate guards), cancel invitations, change member roles (owner-only), and remove members (soft-delete, owner-only) — all protected by SessionGuard at class level.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | TeamService — member/invitation management + 11 unit tests (TDD) | ac8d682 | src/auth/team.service.ts, src/auth/team.service.spec.ts |
| 2 | TeamController — 6 endpoints + final auth.module.ts wiring | ab23d27 | src/auth/team.controller.ts, src/auth/auth.module.ts |

## What Was Built

**TeamService** (`src/auth/team.service.ts`):
- `getMembers(session)`: Queries all active users in the org, returns `{ members: [{ id, name, email, role, joined_at, auth_provider }] }`.
- `getInvitations(session)`: Queries pending, non-expired invitations, returns `{ invitations: [{ id, email, role, expires_at }] }`.
- `createInvitation(session, email, role)`: Guards against `ALREADY_MEMBER` (ConflictException) and `PENDING_INVITATION` (ConflictException). Creates invitation with 7-day expiry, random 256-bit token, calls `EmailService.sendInvitationEmail` (non-blocking). Returns `{ id, email, role, expires_at }`.
- `cancelInvitation(session, invitationId)`: Finds invitation by org + id, throws NotFoundException if not found, hard-deletes.
- `changeRole(session, targetUserId, newRole)`: D-18 inline guard — 403 if not owner or targeting another owner. Updates `user.role`. Returns `{ success: true }`.
- `removeMember(session, targetUserId)`: D-18 inline guard — 403 if not owner, self-targeting, or targeting another owner. Soft-deletes (`isActive: false`).

**TeamController** (`src/auth/team.controller.ts`):
- `@Controller('auth/team')` with `@UseGuards(SessionGuard)` at class level — all 6 endpoints protected.
- `GET members` -> 200, `GET invitations` -> 200, `POST invitations` -> 201, `DELETE invitations/:id` -> 204, `PATCH members/:id/role` -> 200, `DELETE members/:id` -> 204.
- Uses `import type` for JwtPayload and Request to avoid TS1272 isolatedModules decorator metadata error (consistent with Plan 02 pattern).

**AuthModule final state** (`src/auth/auth.module.ts`):
- `controllers: [AuthController, TeamController]`
- `providers: [JwtService, SessionGuard, EmailService, AuthService, InvitationService, TeamService]`
- `exports: [JwtService, SessionGuard, EmailService]`

## Test Results

- 11 new unit tests for TeamService: all passing
- 313 total tests passing (plus 23 todo stubs) across 27 suites
- Build: clean, 0 TypeScript errors

## Deviations from Plan

None — plan executed exactly as written. The `import type` pattern for JwtPayload and Request in team.controller.ts follows the established Plan 02 precedent (not a deviation, just consistent defensive typing).

## Known Stubs

None — all 6 endpoints are fully implemented with real business logic.

## Threat Surface Scan

New network endpoints introduced, all covered by the plan's threat model:
- `GET /auth/team/members` — T-19-18: all queries filter by `organizationId: session.org` from verified JWT; no cross-tenant leakage
- `GET /auth/team/invitations` — T-19-18: same org isolation
- `POST /auth/team/invitations` — T-19-17: role from request body (admin/member/viewer only; owner role blocked by DB CHECK constraint)
- `DELETE /auth/team/invitations/:id` — no threat flag; invitation scoped to org
- `PATCH /auth/team/members/:id/role` — T-19-16: `changeRole()` checks `session.role !== 'owner'` inline (D-18)
- `DELETE /auth/team/members/:id` — T-19-19: `removeMember()` enforces owner + no-self + no-owner-target (D-18)
- T-19-20: `@UseGuards(SessionGuard)` at class level applies to ALL 6 methods

No new threat surface beyond what the plan's threat model covers.

## Self-Check: PASSED

Files created:
- src/auth/team.service.ts — FOUND
- src/auth/team.service.spec.ts — FOUND
- src/auth/team.controller.ts — FOUND

Files modified:
- src/auth/auth.module.ts — FOUND

Commits:
- ac8d682 — FOUND
- ab23d27 — FOUND
