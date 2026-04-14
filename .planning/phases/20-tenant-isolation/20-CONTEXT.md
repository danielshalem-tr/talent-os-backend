# Phase 20: Tenant Isolation - Context

**Gathered:** 2026-04-14
**Status:** Plans already exist and verified — ready for execution

<domain>
## Phase Boundary

Replace the hardcoded `TENANT_ID` env var in all business API endpoints with the authenticated user's organization ID extracted from the session JWT (`req.session.org`). Enforce `SessionGuard` on every business endpoint so unauthenticated callers are rejected and users from Org A can never see data from Org B.

</domain>

<decisions>
## Implementation Decisions

### Guard Strategy

- **D-01:** Apply `@UseGuards(SessionGuard)` at controller class level (not per-method) — ensures no endpoint can accidentally be missed. Pattern matches `TeamController` already in codebase.
- **D-02:** Extract `tenantId = req.session!.org` in each controller method and pass to service as explicit param. Do NOT read from header (`x-tenant-id`) — session cookie is the only trust boundary.

### Tenant Source of Truth

- **D-03:** After this phase, `tenantId` for all business API requests comes exclusively from `req.session.org` (JWT payload). The UI currently sends `x-tenant-id: 'phase1-default-tenant'` header — backend must NOT read this header. It is dead code on the UI side and should be ignored.
- **D-04:** `IngestionProcessor`, `WebhooksService`, and `DedupService` correctly continue using `TENANT_ID` from config — those flows have no user session (Postmark webhook). Leave them untouched.

### Refactor Approach

- **D-05:** Use the 2-wave approach as planned: Wave 1 adds guards + extracts tenantId in controllers; Wave 2 updates service signatures. Waves 1 and 2 must execute together in the same session (Wave 1 alone causes TypeScript errors). Wave 3 updates tests.
- **D-06:** Remove `ConfigService` injection from `CandidatesService`, `JobsService`, `ApplicationsService` after Wave 2 — but only if no other config keys are read. Do NOT remove from ingestion/dedup/webhook modules.

### Endpoint Coverage

- **D-07:** ALL endpoints on guarded controllers are covered — including `GET /candidates/counts`, `GET /candidates/:id/cv-url`, `POST /candidates/:id/reject`, `PATCH /candidates/:id/stage`, `POST /candidates/:id/stages/:stage_id/summary`, `POST /candidates/:id/stages/:stage_id/advance`, `DELETE /jobs/:id/hard`. The class-level guard makes omission impossible.

### Env Vars

- **D-08:** Make `TENANT_ID` optional in `env.ts` — still required by `IngestionProcessor` at runtime but not validated as required at API server startup.
- **D-09:** No RESEND env vars to add — codebase already uses SMTP/nodemailer. SC-11 from roadmap is already satisfied.

</decisions>

<specifics>
## Specific Ideas

- User's primary concern: production-grade isolation where org A users can NEVER see org B data (candidates, jobs, members, any logic). The plan fully delivers this.
- The UI `x-tenant-id: 'phase1-default-tenant'` axios interceptor is harmless but dead — backend never reads it. Can be cleaned up from the UI after this phase ships.

</specifics>

<canonical_refs>

## Canonical References

No external specs — requirements are fully captured in ROADMAP.md success criteria (TENANT-01 through TENANT-07) and the decisions above.

### Existing implementation

- `src/auth/session.guard.ts` — SessionGuard reads `talent_os_session` cookie, sets `req.session: JwtPayload`
- `src/auth/jwt.service.ts` — JwtPayload shape: `{ sub: string, org: string, role: ... }` — `org` is the tenant UUID
- `src/auth/team.controller.ts` — reference implementation of controller-level `@UseGuards(SessionGuard)` + `req.session` pattern

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `SessionGuard` at `src/auth/session.guard.ts` — ready to use, no changes needed
- `JwtPayload.org` — the tenantId field, already typed correctly

### Integration Points

- `CandidatesService` — 11 public methods, 12 `configService.get('TENANT_ID')` callsites to replace
- `JobsService` — 7 methods, 7 callsites
- `ApplicationsService` — 1 method, 1 callsite
- `IngestionProcessor` + `WebhooksService` — keep config-based TENANT_ID, do not touch

### Patterns to Follow

- `TeamController` — exact pattern to replicate: `@UseGuards(SessionGuard)` on class, `@Req() req: Request`, cast `req.session as JwtPayload`

</code_context>
