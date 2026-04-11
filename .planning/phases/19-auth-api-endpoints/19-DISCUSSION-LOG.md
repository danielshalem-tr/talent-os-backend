# Phase 19: Auth API Endpoints — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the discussion.

**Date:** 2026-04-11
**Phase:** 19-auth-api-endpoints
**Mode:** discuss
**Areas discussed:** Session cookie duration, Magic link token storage, Outbound email sending, Onboarding completion tracking, Auth guards

---

## Areas Discussed

### Session Cookie Duration

| Question | Answer |
|----------|--------|
| What JWT duration goes in `talent_os_session`? | 7-day JWT (signRefreshToken) |

**User note:** No Phase 22 exists — all auth endpoints implemented in Phase 19. The 7-day JWT is the permanent session mechanism, not an interim workaround.

---

### Magic Link Token Storage

| Question | Answer |
|----------|--------|
| Where to store magic link login tokens? | Redis with TTL |

Key: `ml:{token}`, value: `{userId}`, TTL: 3600s.

---

### Outbound Email Sending

| Question | Answer |
|----------|--------|
| How to send invitation + magic link emails? | Nodemailer + SMTP |

**User rationale:** Planning to migrate away from Postmark to Amazon SES or self-hosted SMTP via Coolify on Hetzner. Nodemailer ensures provider-agnostic code — only env vars change when switching providers.

---

### Onboarding Completion Tracking

| Question | Answer |
|----------|--------|
| Where is `has_completed_onboarding` tracked? | `onboarding_completed_at` nullable timestamp on Organization |

New Prisma migration required (additive, nullable column on `tenants` table).

---

### Auth Guards

| Question | Answer |
|----------|--------|
| How to implement session extraction + role enforcement? | Create proper NestJS SessionGuard in Phase 19 |

Role checks (Owner-only for team endpoints) are inline in the controller, not a separate guard class.

---

## Scope Clarification

User confirmed: **Phase 19 is the final phase**. No separate Phase 21 (guards) or Phase 22 (refresh tokens) exist in the roadmap. Phase 19 absorbs all auth-related implementation including SessionGuard creation and inline role enforcement for team management endpoints.
