# Phase 18: Database Schema & JWT Infrastructure — Context

**Gathered:** 2026-04-09
**Status:** Ready for planning — updated after plan review (plan corrections applied 2026-04-09)

---

<domain>
## Phase Boundary

Add `organizations`, `users`, and `invitations` tables to PostgreSQL schema to support multi-tenant organization signup, team member invitations, and role-based access control in v2.0. Implement JWT token generation/validation infrastructure (JwtService scaffold with sign() and verify() methods). **No API endpoints in this phase — database schema and service infrastructure only.**

This phase is a **prerequisite for Phase 19–22** (signup flow, admin endpoints, auth middleware, login).
</domain>

<decisions>
## Implementation Decisions

### 1. Table Structure: Tenant → Organization (safe rename)

- **D-01:** **Do NOT drop and recreate the tenants table.** Use `@@map("tenants")` on the `Organization` Prisma model — the DB table stays named `tenants`, the Prisma client becomes `prisma.organization`. This is a zero-risk rename: no migration SQL needed, no v1.0 data touched. The `Tenant` model already uses `@@map("tenants")` — just rename the Prisma model block to `Organization`.

- **D-02:** Keep all `tenant_id` field names throughout the existing v1.0 schema for backward compatibility. `candidates.tenant_id`, `jobs.tenant_id`, etc. continue to reference `organizations.id` via FK — only the Prisma model name changes, not the column names. Add an explicit code comment in schema.prisma: `// tenantId fields intentionally kept in v1.0 tables — they reference organizations.id (@@map("tenants"))`.

- **D-03:** `Organization` model structure:
  - `id` (UUID primary key)
  - `name` (text, required — org display name)
  - `shortId` (varchar(20), unique per database — slug-like identifier for email subject routing, e.g., "triol-01")
  - `logo_url` (text, nullable — org logo for onboarding UI; required by AUTH-002 but uploaded post-creation)
  - `is_active` (boolean, default true — soft-delete flag, reserved for future use)
  - `created_by_user_id` (UUID FK to users.id, nullable — set after first user created; see chicken-and-egg note in D-26)
  - `created_at`, `updated_at` (timestamps with timezone, `@updatedAt`)

- **D-04:** `shortId` generation strategy: generated at org creation time using a slug derived from the org `name` — first 5 alphanumeric chars (lowercase) + hyphen + zero-padded counter that increments per-prefix until unique (e.g., "triol-01", "triol-02"). Implement as `generateOrgShortId(name: string, prisma: PrismaService): Promise<string>` utility in `src/auth/utils/generate-short-id.ts`. Check uniqueness before insert (retry up to 10 times before throwing).

### 2. Users Table Schema

- **D-05:** Create `users` table with:
  - `id` (UUID primary key)
  - `email` (text, required)
  - `auth_provider` (text, required — CHECK constraint: `'google'` | `'magic_link'`) — owners/admins sign up via Google; invited users authenticate via Magic Link per AUTH-001 and AUTH-005
  - `organization_id` (UUID FK to organizations.id, required — tenant isolation)
  - `role` (text, required — CHECK constraint: `'owner'` | `'admin'` | `'member'` | `'viewer'`) — per AUTH-006
  - `full_name` (text, nullable)
  - `is_active` (boolean, default true — soft delete for team members per AUTH-007)
  - `created_at`, `updated_at` (timestamps with timezone, `@updatedAt`)
  - **NO `password_hash` field** — system uses Google OAuth + Magic Link only (AUTH-001/AUTH-005)

- **D-06:** Unique constraint: `(organization_id, email)` — prevents duplicate user emails per organization (allows same email across different orgs).

- **D-07:** No UNIQUE constraint on email globally — same person can sign up for multiple orgs.

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
  - `status` (text, required, default `'pending'` — CHECK constraint: `'pending'` | `'accepted'` | `'expired'`)
  - `expires_at` (timestamp with timezone — 7 days from creation per AUTH-003)
  - `invited_by_user_id` (FK to users.id, required — who sent the invite, for audit)
  - `created_at`, `updated_at` (timestamps with timezone, `@updatedAt`)

- **D-12:** No unique constraint on `(organization_id, email)` for invitations — same person can receive multiple invitations (allows re-send). Application logic in Phase 20 checks for existing pending invitations before creating a new one (AUTH-003: error if pending invite exists).

- **D-13:** `token` must be unique across all invitations (not just per org) — prevents token collision attacks.

- **D-14:** Add a **composite index on `(organization_id, email, status)`** for invitations. Phase 20's "does a pending invitation exist for this email in this org?" query hits this index directly. This replaces the vague "Claude's Discretion" note on invitation indexes — this index is required.

### 5. JWT Service Infrastructure

- **D-15:** JWT library: **`jose`** (ESM-native, zero deps, actively maintained). Do NOT use `@nestjs/jwt` or raw `jsonwebtoken`. Implement `JwtService` as a plain injectable NestJS provider using `jose`'s `SignJWT` and `jwtVerify`. Manual DI is fine — Phase 21 will inject it into guards directly.

- **D-16:** Create `src/auth/jwt.service.ts` with:
  - `sign(payload: JwtPayload, options?: { expiresIn: string | number }): Promise<string>` — generates compact JWT
  - `verify(token: string): Promise<JwtPayload>` — validates and decodes token
  - Throws `UnauthorizedException` on invalid/expired tokens
  - Uses `JWT_SECRET` from ConfigService (validated at startup)

- **D-17:** JWT payload structure — use standard JWT claim names (`sub`, `org`) not verbose equivalents:

  ```json
  {
    "sub": "user-id-uuid",
    "org": "organization-id-uuid",
    "role": "owner|admin|member|viewer",
    "iat": 1234567890,
    "exp": 1234571490
  }
  ```

  **The `JwtPayload` TypeScript type must use `sub` and `org` — not `userId`/`organizationId`. Any plan code or unit tests using `userId`/`organizationId` in the payload are wrong and must be corrected.**

- **D-18:** Token expiry: **Access token = 15 minutes, Refresh token = 7 days** (per REQUIREMENTS.md AUTH-01). Convenience methods `signAccessToken()` and `signRefreshToken()` on the service.

### 6. Environment Configuration

- **D-19:** `JWT_SECRET` must be treated as a first-class environment variable — not an afterthought. Add it to ALL of the following as an explicit plan task with exact file paths:
  1. `.env.example` — with a comment explaining minimum length
  2. `src/config/env.ts` (Zod schema) — validate `JWT_SECRET.length >= 32`, fail fast at startup
  3. `docker-compose.yml` (or `docker-compose.dev.yml`) — add under API and worker service env vars
  4. `prisma/seed.ts` environment section (if it reads env vars)
  5. Any `.env.test` or test setup file — unit tests for JwtService need a valid JWT_SECRET

### 7. Prisma Schema Changes — Split Migration

- **D-20:** **Split into two separate migrations** (not one) to isolate risk:
  - **Migration 1:** Prisma model rename only — rename `Tenant` → `Organization` in schema, `@@map("tenants")` already present, no DB change. This generates an empty or near-empty migration SQL that can be validated cleanly.
  - **Migration 2:** Add `User` and `Invitation` models with all fields, constraints, and indexes.

- **D-21:** Each migration adds raw SQL CHECK constraints (Prisma doesn't support these natively). Constraints to add:
  - `users.role IN ('owner', 'admin', 'member', 'viewer')`
  - `users.auth_provider IN ('google', 'magic_link')`
  - `invitations.status IN ('pending', 'accepted', 'expired')`
  - `invitations.role IN ('admin', 'member', 'viewer')`

- **D-22:** Existing v1.0 data (candidates, jobs, etc.) is **unaffected** — Migration 1 is a zero-change rename; Migration 2 is purely additive.

### 8. Seed File Update

- **D-23:** `prisma/seed.ts` currently calls `prisma.tenant.upsert()`. After the Prisma model rename, this **breaks at compile time**. The seed file must be updated to `prisma.organization.upsert()` as part of Migration 1 work. This must be an explicit task in the plan — it is not a minor detail.

### 9. Org ↔ User Chicken-and-Egg Sequence

- **D-24:** The creation sequence for a new organization has a circular dependency (`organizations.created_by_user_id` FK to `users`, but the user's `organization_id` FK to `organizations`). The resolution is:
  1. **Create Organization** — `created_by_user_id = NULL` (nullable FK)
  2. **Create User** — `organization_id = <new org id>`, `role = 'owner'`
  3. **Update Organization** — `SET created_by_user_id = <new user id>`

  Phase 19 must implement this exact 3-step sequence in a single database transaction. This context decision documents the pattern so Phase 19's planner doesn't have to rediscover it.

### 10. JwtService Integration

- **D-25:** Create `src/auth/auth.module.ts` that exports `JwtService` for dependency injection. No endpoints (Phase 19+).

- **D-26:** `JwtService` is **not responsible** for token refresh logic, logout invalidation, or refresh token storage — those come in Phase 22.

### 11. Testing Strategy

- **D-27:** Unit tests for `JwtService`:
  - `sign()` generates a valid JWT with correct `sub`, `org`, `role` fields (not `userId`/`organizationId`)
  - `verify()` decodes and validates tokens correctly
  - `verify()` throws `UnauthorizedException` on expired tokens
  - `verify()` throws `UnauthorizedException` on tampered tokens
  - Tests use a fixed `JWT_SECRET` from `.env.test` or inline test config (not undefined)

- **D-28:** No integration tests with real auth endpoints in Phase 18 (endpoints come in Phase 19+).

### Claude's Discretion

- Migration file naming convention (timestamp prefix standard)
- Exact Prisma model field ordering/grouping style
- `jose` version to pin (latest stable at time of install)
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

- `src/config/env.ts` (or equivalent config validation file) — existing Zod validation; extend to add `JWT_SECRET` field with `.min(32)` constraint
- `src/prisma/prisma.service.ts` — existing PrismaService, will automatically pick up new models after migration
- `src/app.module.ts` — existing AppModule, add `AuthModule` import
- `prisma/seed.ts` — currently calls `prisma.tenant.upsert()`; **must be updated to `prisma.organization.upsert()`**

### Established Patterns

- `text` fields + CHECK constraints over PostgreSQL ENUMs — use for `role`, `auth_provider`, `status` fields per CLAUDE.md
- UUID primary keys with `@default(dbgenerated("gen_random_uuid()"))` — use for all new models (matches existing pattern in schema)
- `@updatedAt` directive on `updated_at` fields — use on all new models
- Field names use camelCase in Prisma + `@map("snake_case")` — use consistently (e.g., `organizationId @map("organization_id")`)
- `@@map("table_name")` for all models — existing Tenant already uses `@@map("tenants")`
- Environment validation via `@nestjs/config` + Zod at startup — extend for `JWT_SECRET`

### Integration Points

- Existing v1.0 models (Job, Candidate, Application, etc.) reference `Tenant` via `tenantId` relation — Prisma relation references update to `Organization` model name; column names (`tenant_id`) unchanged
- `AppModule` imports new `AuthModule`; `JwtService` exportable for Phase 19/21 injection
- `docker-compose.yml` environment section — must include `JWT_SECRET` for api and worker services
</code_context>

<specifics>
## Specific Ideas

- Table name `invitations` (not `invites`) — matches spec/auth-rules.md terminology throughout AUTH-003 and AUTH-004
- The `'owner'` role is special: it cannot be assigned via invitation (invite dropdown shows Admin/Member/Viewer only per AUTH-003). The owner role is set only at org creation time in Phase 19.
- `invited_by_user_id` on invitations table — needed for Phase 20 audit/display (Settings → Team shows who sent pending invites)
- `logo_url` on Organization is nullable — it's uploaded during onboarding (Phase 19/20), not at DB creation time. The field must exist from day 1 so Phase 20 doesn't require a schema migration.
- JWT payload uses `sub`/`org` (JWT standard short names) not `userId`/`organizationId` — smaller token, standard-compliant. The `JwtPayload` type definition enforces this.
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
- Actual DB table rename (`tenants` → `organizations`) — deferred post-v2.0 launch. Current approach uses `@@map("tenants")` as a safe intermediate step.

### Note on REQUIREMENTS.md

REQUIREMENTS.md AUTH-02 (password signup), AUTH-03 (password login), and RBAC-01 (3 roles: admin/recruiter/viewer) are superseded by spec/auth-rules.md. Phase 19+ planning should use spec/auth-rules.md as the authoritative source. Recommend updating REQUIREMENTS.md as a separate quick task.
</deferred>

---

_Phase: 18-database-schema-jwt-infrastructure_
_Context updated: 2026-04-09 (plan review corrections: @@map approach, logo_url, jose JWT, invitations index, shortId utility, chicken-and-egg doc, JWT_SECRET first-class, split migrations, seed file update)_
