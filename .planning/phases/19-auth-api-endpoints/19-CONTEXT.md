# Phase 19: Auth API Endpoints — Context

**Gathered:** 2026-04-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement all 14 Auth API endpoints from PROTOCOL.md §7 — session management via HTTP-only cookies, Google OAuth sign-up/login, magic link login, invitation acceptance, and team management (members + invitations). All endpoints must match the contract exactly.

**This is the final auth phase.** There are no separate phases for auth guards (previously "Phase 21") or token refresh (previously "Phase 22"). Everything auth-related is implemented here.

Phase 18 prerequisite is complete: `Organization`, `User`, `Invitation` tables exist; `JwtService` with `sign()`/`verify()`/`signAccessToken()`/`signRefreshToken()` is implemented.
</domain>

<decisions>
## Implementation Decisions

### 1. Session Cookie

- **D-01:** The `talent_os_session` HTTP-only cookie contains a **7-day JWT** (using `signRefreshToken()` — 7d duration). This is the permanent session mechanism; there is no short-lived access token + refresh token rotation in this phase. Users stay logged in for 7 days per login.

- **D-02:** Cookie settings: `httpOnly: true`, `sameSite: 'lax'`, `path: '/'`, `maxAge: 7 * 24 * 60 * 60 * 1000` (7 days in ms). In production, add `secure: true` when `NODE_ENV === 'production'`.

- **D-03:** All endpoints that create a session (POST /auth/google/verify, POST /auth/invite/:token/accept, GET /auth/magic-link/verify) MUST set the cookie in the response using NestJS `@Res({ passthrough: true })` pattern.

- **D-04:** `POST /auth/logout` clears the cookie by setting `maxAge: 0` (or calling `res.clearCookie('talent_os_session')`). Returns `{ success: true }`.

### 2. Magic Link Token Storage

- **D-05:** Magic link login tokens (for `POST /auth/magic-link` → `GET /auth/magic-link/verify`) are stored in **Redis** with a 1-hour TTL. No new DB table needed.

- **D-06:** Redis key format: `ml:{token}` → value: `{userId}` (the user's UUID). TTL: 3600 seconds. Token: cryptographically random, generated with `crypto.randomBytes(32).toString('hex')`.

- **D-07:** On `GET /auth/magic-link/verify?token={token}`:
  1. Look up `ml:{token}` in Redis
  2. If not found → 404
  3. If found but `expires_at` check needed → Redis TTL handles expiry automatically; treat `nil` as expired → 410
  4. If found → delete key (one-time use), load user from DB, set session cookie, redirect to `/`

- **D-08:** The magic link URL emailed to the user: `{FRONTEND_URL}/auth/magic-link/verify?token={token}`. `FRONTEND_URL` must be an env var (needed for building the redirect URL and CORS config).

### 3. Outbound Email — Nodemailer + SMTP

- **D-09:** Use **Nodemailer** for all outbound emails (invitation emails, magic link emails). Provider-agnostic: swapping to Amazon SES, Postmark, or a self-hosted Coolify SMTP requires only env var changes, no code changes.

- **D-10:** New env vars (add to `src/config/env.ts` Zod schema, `.env.example`, `docker-compose.yml`):
  - `SMTP_HOST` — SMTP server hostname
  - `SMTP_PORT` — SMTP port (default: 587)
  - `SMTP_USER` — SMTP auth username
  - `SMTP_PASS` — SMTP auth password
  - `SMTP_FROM` — sender address (e.g., `"Triolla <noreply@triolla.io>"`)
  - `FRONTEND_URL` — base URL for constructing links in emails (e.g., `https://talentos.triolla.io`)

- **D-11:** Create `src/auth/email.service.ts` with `EmailService` (NestJS injectable). Methods:
  - `sendInvitationEmail(to: string, orgName: string, role: string, token: string): Promise<void>`
  - `sendMagicLinkEmail(to: string, token: string): Promise<void>`
  - `sendUseGoogleEmail(to: string): Promise<void>` — sent when a Google-auth user tries magic link login

- **D-12:** In `NODE_ENV === 'development'` (or `test`), if SMTP vars are absent, log the email content to console instead of throwing. This allows local dev without SMTP configured.

### 4. Onboarding Completion Tracking

- **D-13:** Add `onboardingCompletedAt` (nullable timestamp) to the `Organization` model in `prisma/schema.prisma`:

  ```
  onboardingCompletedAt DateTime? @map("onboarding_completed_at") @db.Timestamptz
  ```

  Run a new Prisma migration. NULL = onboarding not done; timestamp present = onboarding complete.

- **D-14:** `POST /auth/onboarding` sets `onboardingCompletedAt = new Date()` on the user's organization. Returns `409 Conflict` if `onboardingCompletedAt` is already set.

- **D-15:** `GET /auth/me` derives `has_completed_onboarding: org.onboardingCompletedAt !== null`.

### 5. Auth Guard (SessionGuard)

- **D-16:** Implement a `SessionGuard` (implements `CanActivate`) in `src/auth/session.guard.ts`. It:
  1. Reads `talent_os_session` from `request.cookies`
  2. Calls `JwtService.verify(token)` to validate the JWT
  3. Attaches the decoded `JwtPayload` to `request['session']` (typed via interface augmentation)
  4. Returns `true` to allow, or throws `UnauthorizedException` if no cookie or invalid token

- **D-17:** Apply `@UseGuards(SessionGuard)` to all endpoints that require authentication. Unauthenticated endpoints (POST /auth/google/verify, GET /auth/invite/:token, POST /auth/invite/:token/accept, POST /auth/magic-link, GET /auth/magic-link/verify) do NOT use this guard.

- **D-18:** Role enforcement for Owner-only endpoints is **inline in the controller** — no separate role guard class:
  - `PATCH /auth/team/members/:id/role` — throw `403 ForbiddenException` if `session.role !== 'owner'` or target user `role === 'owner'`
  - `DELETE /auth/team/members/:id` — throw `403 ForbiddenException` if `session.role !== 'owner'`, or target is themselves, or target is another Owner

### 6. Google OAuth

- **D-19:** Backend flow: frontend gets `access_token` from Google (implicit flow via `useGoogleLogin`), sends it to `POST /auth/google/verify`. Backend calls `https://www.googleapis.com/oauth2/v3/userinfo` with the token to get `{ email, name, picture }`.

- **D-20:** Dev stub: if `GOOGLE_CLIENT_ID` env var is absent (or `NODE_ENV === 'development'` without it), skip the Google UserInfo API call and instead parse the access_token as a JSON object `{ email, name }` directly. This allows frontend devs to test the flow without real Google credentials.

- **D-21:** On sign-up (new email):
  1. Create `Organization` with `created_by_user_id = NULL` (D-24 from Phase 18: 3-step sequence)
  2. Create `User` with `role = 'owner'`, `auth_provider = 'google'`, `providerId = sub` (from Google)
  3. Update `Organization.createdByUserId = user.id`
     All in a single DB transaction.

- **D-22:** On returning user: look up by `(organizationId, email)`. If found and `auth_provider === 'google'`, issue a new session. If found but `auth_provider !== 'google'`, return `409 { code: "EMAIL_EXISTS" }`.

### 7. Org Name Default at Sign-Up

- **D-23:** When a new org is created via Google sign-up, set `org.name` to the email domain (e.g., `sarah@company.com` → `"company.com"`). Onboarding will overwrite this with the real name later. `shortId` is generated at this point using `generateOrgShortId()` (from Phase 18 utils).

### Claude's Discretion

- NestJS module structure (one `AuthController` or split into `AuthController` + `TeamController` — split is fine if it keeps file sizes manageable)
- Exact cookie flag for `sameSite` (`lax` vs `strict`) — `lax` is correct for cross-site OAuth redirects
- Error message strings (only error codes are contracted in PROTOCOL.md)
- Prisma transaction API (`prisma.$transaction()` callback style)
- `@Req()` vs `@Session()` decorator approach for reading the attached session payload
  </decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Auth endpoint contracts (authoritative)

- `PROTOCOL.md` §7 "Auth API" — All 14 endpoint contracts: request/response shapes, error codes, cookie names, redirect behavior. The single source of truth for what each endpoint must return.

### Auth behavior and role definitions (authoritative)

- `spec/auth-rules.md` — Complete auth requirements: role definitions (AUTH-006), invite flow (AUTH-003/004), login methods (AUTH-001/AUTH-005), user management (AUTH-007). Defines which roles can perform which actions.

### Phase 18 schema decisions (prerequisite context)

- `.planning/phases/18-database-schema-jwt-infrastructure/18-CONTEXT.md` — All DB schema decisions locked in Phase 18 (D-01 through D-32). Critical: JWT payload shape (`sub`/`org`/`role`), chicken-and-egg org creation sequence (D-24), `invitations` table structure, CHECK constraints.

### Legacy requirements (partially superseded)

- `.planning/REQUIREMENTS.md` §"Authentication & Sessions" — AUTH-01 (JWT token config) is valid; AUTH-02/AUTH-03/RBAC-01 are superseded by spec/auth-rules.md.

### Project constraints

- `CLAUDE.md` — Stack constraints (NestJS 11, Prisma 7, PostgreSQL 16), DB conventions (text + CHECK, @updatedAt).
  </canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `src/auth/jwt.service.ts` — `JwtService` with `sign()`, `verify()`, `signAccessToken()` (15m), `signRefreshToken()` (7d). Inject via `AuthModule`.
- `src/auth/auth.module.ts` — `AuthModule` already exports `JwtService`. Add `SessionGuard`, `EmailService` as providers.
- `src/auth/utils/generate-short-id.ts` — `generateOrgShortId()` utility from Phase 18. Use at org creation in `POST /auth/google/verify`.
- `src/config/env.ts` — Zod env schema. Extend to add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `FRONTEND_URL`, `GOOGLE_CLIENT_ID` (optional).
- `src/prisma/prisma.service.ts` — PrismaService for `prisma.organization`, `prisma.user`, `prisma.invitation`.
- `src/storage/` — R2 storage service for `POST /auth/onboarding` logo upload (reuse existing upload pattern).

### Established Patterns

- `text` + CHECK constraints over enums — do NOT change `users.role` or `invitations.role` constraint values
- UUID primary keys via `gen_random_uuid()` — consistent with all existing models
- `@UseGuards()` pattern is standard NestJS — `SessionGuard` follows this
- Cookie parsing: NestJS uses `cookie-parser` middleware; confirm it's installed and applied in `main.ts`
- Error format: `{ error: { code, message, details? } }` — all auth endpoints MUST use this format (see PROTOCOL.md "Error Response Format")

### Integration Points

- `src/app.module.ts` — Import `AuthModule`; ensure `CacheModule`/Redis is available for magic link token storage
- `src/main.ts` — Ensure `cookie-parser` middleware and CORS with `credentials: true` are configured. CORS must allow `FRONTEND_URL` origin with credentials.
- `src/storage/` — `POST /auth/onboarding` logo upload goes to R2 via existing StorageService
- Redis (BullMQ connection already exists) — reuse Redis connection for magic link tokens (`ioredis` or NestJS `CacheModule` with Redis adapter)
  </code_context>

<specifics>
## Specific Ideas

- Email sending via Nodemailer is provider-agnostic by design. The plan for future migration: Amazon SES or self-hosted SMTP via Coolify on Hetzner. No code changes required — only env var swap.
- Magic link URL format: `{FRONTEND_URL}/auth/magic-link/verify?token={token}` (must match the frontend route)
- Invitation magic link URL: `{FRONTEND_URL}/invite?token={token}` (per spec/auth-rules.md AUTH-003)
- `onboarding_completed_at` needs a Prisma migration — this is a new column on the existing `tenants` table (which maps to `Organization` model). Migration is additive (nullable column, no data risk).
  </specifics>

<deferred>
## Deferred Ideas

- Refresh token rotation (short-lived access + long-lived refresh with rotation) — out of scope; session is a single 7-day JWT
- Email template styling (HTML emails with branding) — use plain text or minimal HTML for now
- Token refresh endpoint (`POST /auth/refresh`) — no refresh needed with 7-day session JWT

---

_Phase: 19-auth-api-endpoints_
_Context gathered: 2026-04-11_
</deferred>
