# Phase 18: Database Schema & JWT Infrastructure — Context

**Gathered:** 2026-04-07
**Status:** Ready for research and planning

---

## Phase Boundary

Add `organizations`, `users`, `roles`, and `invites` tables to PostgreSQL schema to support multi-tenant organization signup, admin user management, and role-based access control in v2.0. Implement JWT token generation/validation infrastructure (JwtService scaffold with sign() and verify() methods). **No API endpoints in this phase — database schema and service infrastructure only.**

This phase is a **prerequisite for Phase 19–22** (signup flow, admin endpoints, auth middleware, login).

---

## Implementation Decisions

### 1. Table Structure: Rename tenants → organizations

- **D-01:** Rename `tenants` table to `organizations` in Prisma schema and database migration.
- **D-02:** Keep all `tenant_id` field names throughout the schema for backward compatibility (e.g., `candidates.tenant_id` still references `organizations.id`).
- **D-03:** `organizations` table structure:
  - `id` (UUID primary key)
  - `name` (text, required — org display name)
  - `shortId` (varchar, unique per database — slug-like identifier for email subject routing, e.g., "triol-01")
  - `created_by_user_id` (FK to users.id, nullable initially — admin user created after org)
  - `created_at`, `updated_at` (timestamps with timezone)
  - `is_active` (boolean, default true — soft-delete flag for orgs, not used in Phase 18 but reserved)

### 2. Users Table Schema

- **D-04:** Create `users` table with:
  - `id` (UUID primary key)
  - `email` (text, required)
  - `password_hash` (text, required — bcrypt hash, but marked for deprecation with note: "Will be replaced by Google OAuth / Magic Link in future phase")
  - `organization_id` (FK to organizations.id, required)
  - `role` (text CHECK constraint: 'admin' | 'recruiter' | 'viewer')
  - `full_name` (text, nullable)
  - `is_active` (boolean, default true — soft delete for team members)
  - `created_at`, `updated_at` (timestamps with timezone)

- **D-05:** Unique constraint: `(organization_id, email)` — prevents duplicate user emails per organization (allows same email across different orgs).

- **D-06:** No UNIQUE constraint on email globally — same person can sign up for multiple orgs.

### 3. Password Management (Temporary)

- **D-07:** Use `bcryptjs` (pure JavaScript, no native deps) for password hashing. Do NOT use raw `crypto.pbkdf2` or algorithms.
- **D-08:** **CRITICAL NOTE:** Password-based auth is a **temporary MVP solution** to get the full system working (signup → roles → login → recruiter UI). This MUST be replaced with **Google OAuth or Magic Link authentication** in a future phase (Phase 23+). Do NOT optimize password storage beyond what bcryptjs provides.
- **D-09:** Password field is `password_hash` (storing hash, never plaintext). Hashing happens at signup; comparison happens at login via bcrypt.compare().

### 3.5. Role Model Schema

- **D-09a:** Create `roles` table with:
  - `id` (UUID primary key)
  - `organization_id` (FK to organizations.id, required)
  - `name` (text, required — e.g., "Admin", "Recruiter", "Viewer")
  - `permissions` (text[], required — PostgreSQL array of permission strings, e.g., `['org:settings:manage', 'team:manage']`)
  - `created_at`, `updated_at` (timestamps with timezone)

- **D-09b:** Unique constraint: `(organization_id, name)` — role names unique per organization.

- **D-09c:** Permissions stored as **PostgreSQL text array** for simplicity and easy future migration to JSONB. Support these base permissions:
  - `org:settings:manage` — Manage organization details, roles, billing
  - `team:manage` — Invite users, revoke access, change roles
  - `jobs:read`, `jobs:write`, `jobs:delete` — Job and stage management
  - `candidates:read`, `candidates:write`, `candidates:delete` — Candidate management

### 3.6. Invite Model Schema

- **D-09d:** Create `invites` table with:
  - `id` (UUID primary key)
  - `organization_id` (FK to organizations.id, required)
  - `email` (text, required — email address being invited)
  - `role_id` (FK to roles.id, required — role assigned on acceptance)
  - `token` (text, unique — secure, time-limited acceptance token)
  - `status` (text CHECK constraint: 'pending' | 'accepted' | 'expired')
  - `expires_at` (timestamp with timezone — invite expiry time)
  - `created_at`, `updated_at` (timestamps with timezone)

- **D-09e:** No unique constraint on (organization_id, email) for invites — same person can receive multiple pending invites to same org (allows re-sending).

### 4. JWT Service Infrastructure

- **D-10:** Create `src/auth/jwt.service.ts` with:
  - `sign(payload: { userId: string; organizationId: string; role: string }, expiresIn?: string): string` — generates access token
  - `verify(token: string): { userId: string; organizationId: string; role: string }` — validates and decodes token
  - Throws `UnauthorizedException` on invalid/expired tokens
  - Uses `process.env.JWT_SECRET` (must be loaded from environment)

- **D-11:** JWT payload structure:

  ```json
  {
    "sub": "user-id-uuid",
    "org": "organization-id-uuid",
    "role": "admin|recruiter|viewer",
    "iat": 1234567890,
    "exp": 1234571490
  }
  ```

- **D-12:** Token expiry: **Access token = 15 minutes, Refresh token = 7 days** (decided in REQUIREMENTS.md AUTH-01, implemented in Phase 22).

### 5. Environment Configuration

- **D-13:** Add `JWT_SECRET` to `.env.example` and validation schema (`src/config/env.ts`):
  ```
  JWT_SECRET=your-secret-key-min-32-chars
  ```

  - Validate that `JWT_SECRET.length >= 32` (minimum entropy for HMAC-SHA256)
  - Fail fast at startup if missing or too short
  - No auto-generation — must be explicitly provided

### 6. Prisma Schema Changes

- **D-14:** Create a **single Prisma migration** that:
  1. Renames `Tenant` model to `Organization` (preserves table name via `@@map("organizations")`)
  2. Adds new `User` model with role field
  3. Adds new `Role` model with permissions array
  4. Adds new `Invite` model with token and status fields
  5. Updates all relations in existing models to reference `Organization` instead of `Tenant`
  6. Adds CHECK constraint on users.role: `(role IN ('admin', 'recruiter', 'viewer'))`
  7. Adds CHECK constraint on invites.status: `(status IN ('pending', 'accepted', 'expired'))`
  8. Adds UNIQUE constraint on `(organization_id, email)` for users
  9. Adds UNIQUE constraint on `(organization_id, name)` for roles
  10. Adds UNIQUE constraint on `token` for invites

- **D-15:** Existing v1.0 data (candidates, jobs, etc.) is **unaffected** — migration is purely additive for new tables and structural changes.

- **D-16:** Create Prisma `@relation` navigation from `Organization → User[]` and `User → Organization`.

### 7. JwtService Integration

- **D-17:** Create `src/auth/auth.module.ts` that:
  - Exports `JwtService` for use in other modules
  - Does NOT include any endpoints (that's Phase 19+)
  - Provides `JwtService` as a provider for dependency injection

- **D-18:** `JwtService` is **not responsible** for token refresh logic, logout invalidation, or refresh token storage — those come in Phase 22. Phase 18 is signing/verification only.

### 8. Validation at Startup

- **D-19:** Update `src/config/env.ts` to validate:
  - `JWT_SECRET` is present and >= 32 characters
  - App fails immediately on startup if missing (don't continue with default or empty secret)

- **D-20:** Validation happens in `src/app.module.ts` or via NestJS lifecycle hooks before the app starts listening.

### 9. Testing Strategy

- **D-21:** Unit tests for `JwtService`:
  - `sign()` generates a valid JWT
  - `verify()` decodes and validates tokens correctly
  - `verify()` throws on expired/invalid tokens
  - Payload contains correct user_id, organization_id, role

- **D-22:** Prisma schema tests:
  - Organizations table created with correct fields and constraints
  - Users table created with role CHECK constraint and (organization_id, email) uniqueness
  - Roles table created with permissions array and (organization_id, name) uniqueness
  - Invites table created with token uniqueness and status CHECK constraint
  - Foreign key relationships functional (users→organizations, roles→organizations, invites→organizations)

- **D-23:** No integration tests with real auth endpoints in Phase 18 (endpoints come in Phase 19).

### 10. Notes & Deprecation

- **D-24:** Add a comment in `users.password_hash` field in schema.prisma:

  ```prisma
  password_hash String // TEMPORARY: Phase 19 MVP. Will be replaced by Google OAuth / Magic Link in Phase 23+
  ```

- **D-25:** Do NOT implement password reset, password change, or advanced password policies in Phase 18 — those are out of scope. Phase 18 is schema + sign/verify only.

- **D-26:** Refresh token storage (database table for invalidation) is **Phase 22 scope**, not Phase 18.

---

## Prior Context & Locked Decisions

**From v1.0 (locked):**

- Tech stack: TypeScript, NestJS 11, Prisma 7, PostgreSQL 16
- Multi-tenancy from day 1: all tables have tenant_id (now organization_id)
- Database-first approach: schema in Prisma, migrations clean
- Environment variables validated at startup via @nestjs/config + Zod

**From v2.0 Planning:**

- Phase 18 is a prerequisite — all other phases depend on schema
- Phases 19–22 can be parallel after Phase 18 completes
- Future: OAuth will replace password auth (out of scope for v2.0)

---

## Success Criteria

1. ✓ `organizations` table created with all required fields (name, shortId, created_by_user_id, timestamps)
2. ✓ `users` table created with email, password_hash, organization_id FK, role CHECK, is_active flag
3. ✓ `roles` table created with organization_id FK, name, permissions (text[])
4. ✓ `invites` table created with organization_id FK, email, role_id FK, token (unique), status CHECK, expires_at
5. ✓ Unique constraint on (organization_id, email) prevents duplicate users per org
6. ✓ Unique constraint on (organization_id, name) prevents duplicate role names per org
7. ✓ JwtService scaffolded with sign() and verify() methods
8. ✓ JWT_SECRET validated at startup (>= 32 chars, fail fast if missing)
9. ✓ Prisma migration runs cleanly; existing v1.0 data unaffected
10. ✓ AuthModule created and exports JwtService for dependency injection
11. ✓ All unit tests passing for JwtService and schema validation

---

## What's NOT in Phase 18

- ❌ No API endpoints (POST /auth/signup, POST /auth/login, etc. — Phase 19+)
- ❌ No role management endpoints (POST /admin/roles, etc. — Phase 20+)
- ❌ No invite endpoints (POST /admin/invites, etc. — Phase 20+)
- ❌ No auth middleware/guards (Phase 21)
- ❌ No refresh token storage or invalidation logic (Phase 22)
- ❌ No password reset, password change flows (future enhancement)
- ❌ No OAuth integration (Phase 23+)
- ❌ No email sending (Phase 19+ when user invites implemented)
- ❌ No seed data for default roles (can be added in Phase 19+ as needed)

---

## Known Risks & Mitigations

| Risk                                                  | Mitigation                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Renaming tenants → organizations breaks existing code | All existing models updated in same migration; tests validate relations      |
| JWT_SECRET in env var exposed in logs                 | Validate secret length > 32; never log secret value; use `.env.gitignore`    |
| Password field feels permanent                        | Add clear DEPRECATION comment in schema; plan Phase 23 OAuth swap in ROADMAP |
| Migration conflicts with ongoing v1.0 work            | Phase 18 is schema-only; no changes to existing v1.0 endpoints               |

---

**Ready for research and planning phases.**
