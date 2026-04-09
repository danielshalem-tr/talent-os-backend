# Phase 18: Database Schema & JWT Infrastructure — Context

**Gathered:** 2026-04-09
**Status:** Ready for planning — updated to align with spec/auth-rules.md

---

<domain>
## Phase Boundary

Add `organizations`, `users`, and `invitations` tables to PostgreSQL schema to support multi-tenant organization signup, team member invitations, and role-based access control in v2.0. Implement JWT token generation/validation infrastructure (JwtService scaffold with sign() and verify() methods). **No API endpoints in this phase — database schema and service infrastructure only.**

This phase is a **prerequisite for Phase 19–22** (signup flow, admin endpoints, auth middleware, login).
</domain>

<decisions>
## Implementation Decisions

### 1. Table Structure: Rename tenants → organizations

- **D-01:** Rename `tenants` table to `organizations` in Prisma schema and database migration.
- **D-02:** Keep all `tenant_id` field names throughout the existing v1.0 schema for backward compatibility (e.g., `candidates.tenant_id` still references `organizations.id`).
- **D-03:** `organizations` table structure:
  - `id` (UUID primary key)
  - `name` (text, required — org display name)
  - `shortId` (varchar, unique per database — slug-like identifier for email subject routing, e.g., "triol-01")
  - `created_by_user_id` (FK to users.id, nullable initially — populated after first user created)
  - `created_at`, `updated_at` (timestamps with timezone)
  - `is_active` (boolean, default true — soft-delete flag, reserved for future use)

### 2. Users Table Schema

- **D-04:** Create `users` table with:
  - `id` (UUID primary key)
  - `email` (text, required)
  - `auth_provider` (text, required — CHECK constraint: `'google'` | `'magic_link'`) — owners/admins sign up via Google; invited users authenticate via Magic Link per AUTH-001 and AUTH-005
  - `organization_id` (FK to organizations.id, required)
  - `role` (text, required — CHECK constraint: `'owner'` | `'admin'` | `'member'` | `'viewer'`) — per AUTH-006
  - `full_name` (text, nullable)
  - `is_active` (boolean, default true — soft delete for team members per AUTH-007)
  - `created_at`, `updated_at` (timestamps with timezone)

- **D-05:** Unique constraint: `(organization_id, email)` — prevents duplicate user emails per organization (allows same email across different orgs).

- **D-06:** No UNIQUE constraint on email globally — same person can sign up for multiple orgs.

- **D-07:** **NO password_hash field.** The spec (auth-rules.md) defines Google OAuth for owners/admins and Magic Link for invited users — no password-based auth exists anywhere in the system.

### 3. Roles Model

- **D-08:** Roles are **fixed system-level roles** — no custom `roles` table. The 4 roles and their permissions are defined in application code (Phase 21 guard layer), not stored in the database.

- **D-09:** Role values stored as text CHECK constraint on `users.role`:
  - `'owner'` — full access + change/remove users; always the first person who created the org; cannot be changed or removed via UI per AUTH-006 and AUTH-007
  - `'admin'` — everything Member + invite users + org settings + manage AI Agents per AUTH-006
  - `'member'` — everything Viewer + create/edit Job Openings + move candidates per AUTH-006
  - `'viewer'` — read-only access to Pipeline, Talent Pool, Reports per AUTH-006

- **D-10:** The `'owner'` role can only be set programmatically at org creation (Phase 19). It cannot be assigned via invite (AUTH-003 invitation role dropdown is Admin/Member/Viewer only).

### 4. Invitations Table Schema

- **D-11:** Create `invitations` table (named `invitations` to match spec terminology in AUTH-003/AUTH-004):
  - `id` (UUID primary key)
  - `organization_id` (FK to organizations.id, required)
  - `email` (text, required — email address being invited)
  - `role` (text, required — CHECK constraint: `'admin'` | `'member'` | `'viewer'`) — role assigned on acceptance; `'owner'` cannot be invited per AUTH-003
  - `token` (text, unique — secure, one-time acceptance token; valid 7 days per AUTH-003)
  - `status` (text, required — CHECK constraint: `'pending'` | `'accepted'` | `'expired'`)
  - `expires_at` (timestamp with timezone — 7 days from creation per AUTH-003)
  - `invited_by_user_id` (FK to users.id, required — who sent the invite, for audit)
  - `created_at`, `updated_at` (timestamps with timezone)

- **D-12:** No unique constraint on `(organization_id, email)` for invitations — same person can receive multiple invitations (allows re-send). However, application logic in Phase 20 must check for existing pending invitations before creating a new one (AUTH-003: error if pending invite exists).

- **D-13:** `token` must be unique across all invitations (not just per org) — prevents token collision attacks.

### 5. JWT Service Infrastructure

- **D-14:** Create `src/auth/jwt.service.ts` with:
  - `sign(payload: JwtPayload, options?: SignOptions): string` — generates access token
  - `verify(token: string): JwtPayload` — validates and decodes token
  - Throws `UnauthorizedException` on invalid/expired tokens
  - Uses `process.env.JWT_SECRET` (loaded from environment, validated at startup)

- **D-15:** JWT payload structure:

  ```json
  {
    "sub": "user-id-uuid",
    "org": "organization-id-uuid",
    "role": "owner|admin|member|viewer",
    "iat": 1234567890,
    "exp": 1234571490
  }
  ```

- **D-16:** Token expiry: **Access token = 15 minutes, Refresh token = 7 days** (per REQUIREMENTS.md AUTH-01). Convenience methods `signAccessToken()` and `signRefreshToken()` on the service.

### 6. Environment Configuration

- **D-17:** Add `JWT_SECRET` to `.env.example` and validation schema (`src/config/env.ts`):
  - Validate `JWT_SECRET.length >= 32` (minimum entropy for HMAC-SHA256)
  - Fail fast at startup if missing or too short
  - No auto-generation — must be explicitly provided

### 7. Prisma Schema Changes

- **D-18:** Create a **single Prisma migration** that:
  1. Renames `Tenant` model to `Organization`
  2. Adds new `User` model (with `auth_provider` and 4-value role CHECK)
  3. Adds new `Invitation` model (with role CHECK: admin|member|viewer only)
  4. Updates all relations in existing models to reference `Organization` instead of `Tenant`
  5. Adds CHECK constraint on `users.role`: `(role IN ('owner', 'admin', 'member', 'viewer'))`
  6. Adds CHECK constraint on `users.auth_provider`: `(auth_provider IN ('google', 'magic_link'))`
  7. Adds CHECK constraint on `invitations.status`: `(status IN ('pending', 'accepted', 'expired'))`
  8. Adds CHECK constraint on `invitations.role`: `(role IN ('admin', 'member', 'viewer'))`
  9. Adds UNIQUE constraint on `(organization_id, email)` for users
  10. Adds UNIQUE constraint on `token` for invitations

- **D-19:** Existing v1.0 data (candidates, jobs, etc.) is **unaffected** — migration is purely additive.

### 8. JwtService Integration

- **D-20:** Create `src/auth/auth.module.ts` that exports `JwtService` for dependency injection. No endpoints (Phase 19+).

- **D-21:** `JwtService` is **not responsible** for token refresh logic, logout invalidation, or refresh token storage — those come in Phase 22.

### 9. Testing Strategy

- **D-22:** Unit tests for `JwtService`:
  - `sign()` generates a valid JWT
  - `verify()` decodes and validates tokens correctly
  - `verify()` throws on expired/invalid tokens
  - Payload contains correct userId, organizationId, role

- **D-23:** No integration tests with real auth endpoints in Phase 18 (endpoints come in Phase 19+).

### Claude's Discretion

- Exact index definitions on invitations (beyond UNIQUE on token)
- Migration file naming convention
- Prisma model naming (singular PascalCase standard)
  </decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Auth behavior and role definitions (authoritative)

- `spec/auth-rules.md` — Complete auth requirements: role definitions (AUTH-006), invite flow (AUTH-003/004), login methods (AUTH-005), user management (AUTH-007). **Supersedes REQUIREMENTS.md AUTH-02, AUTH-03, and RBAC-01 for role names and auth methods.**

### Legacy requirements (partially superseded)

- `.planning/REQUIREMENTS.md` §"Authentication & Sessions" — AUTH-01 (JWT token config) remains valid; AUTH-02/AUTH-03/RBAC-01 role names and auth methods superseded by spec/auth-rules.md

### Project constraints

- `CLAUDE.md` — Stack constraints (TypeScript, NestJS 11, Prisma 7, PostgreSQL 16), DB conventions (text + CHECK constraints over ENUMs, no binary blobs, @updatedAt)
  </canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `src/config/env.ts` (or equivalent config validation file) — existing Zod validation; extend to add `JWT_SECRET` field
- `src/prisma/prisma.service.ts` — existing PrismaService, will automatically pick up new models after migration
- `src/app.module.ts` — existing AppModule, add `AuthModule` import

### Established Patterns

- `text` fields + CHECK constraints over PostgreSQL ENUMs — use for `role`, `auth_provider`, `status` fields per CLAUDE.md
- UUID primary keys with `@default(uuid())` — use for all new models
- `@updatedAt` directive on `updated_at` fields — use on all new models
- snake_case field names in Prisma schema (`organization_id`, `created_at`) — use consistently
- Environment validation via `@nestjs/config` + Zod at startup — extend for `JWT_SECRET`

### Integration Points

- Existing v1.0 models (Job, Candidate, Application, etc.) reference `Tenant` via `tenantId` — all must be updated to reference `Organization` in Prisma relations, though the field names (`tenantId`) stay unchanged
- `AppModule` imports new `AuthModule`; `JwtService` exportable for Phase 19/21 injection
  </code_context>

<specifics>
## Specific Ideas

- Table name `invitations` (not `invites`) — matches spec/auth-rules.md terminology throughout AUTH-003 and AUTH-004
- The `'owner'` role is special: it cannot be assigned via invitation (invite dropdown shows Admin/Member/Viewer only per AUTH-003). The owner role is set only at org creation time in Phase 19.
- `invited_by_user_id` on invitations table — needed for Phase 20 audit/display (Settings → Team shows who sent pending invites)
  </specifics>

<deferred>
## Deferred Ideas

- Magic Link token generation and email sending — Phase 19/20 (invitation flow endpoints)
- Google OAuth callback and session handling — Phase 19
- Refresh token storage table (for invalidation) — Phase 22
- Auth middleware / guards / role-based guards — Phase 21
- Email notification when user removed (AUTH-007) — Phase 20
- Role change immediate session invalidation strategy — Phase 21/22
- Owner role transfer (out of scope per AUTH-007 constraints — requires manual DB change)

### Note on REQUIREMENTS.md

REQUIREMENTS.md AUTH-02 (password signup), AUTH-03 (password login), and RBAC-01 (3 roles: admin/recruiter/viewer) are superseded by spec/auth-rules.md. Phase 19+ planning should use spec/auth-rules.md as the authoritative source. Recommend updating REQUIREMENTS.md as a separate quick task.
</deferred>

---

_Phase: 18-database-schema-jwt-infrastructure_
_Context updated: 2026-04-09 (aligned with spec/auth-rules.md)_
