---
phase: 19
slug: auth-api-endpoints
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-11
---

# Phase 19 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Jest 29.x + @nestjs/testing + supertest |
| **Config file** | `jest.config.js` |
| **Quick run command** | `npm test -- --testPathPattern=auth` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- --testPathPattern=auth`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 19-01-01 | 01 | 0 | AUTH-001 | — | SessionGuard rejects missing/invalid cookies with 401 | unit | `npm test -- --testPathPattern=session.guard` | ❌ W0 | ⬜ pending |
| 19-01-02 | 01 | 0 | AUTH-001 | — | EmailService logs to console when SMTP_HOST absent in dev | unit | `npm test -- --testPathPattern=email.service` | ❌ W0 | ⬜ pending |
| 19-02-01 | 02 | 1 | AUTH-001 | — | GET /auth/me returns 401 when no session cookie | e2e | `npm test -- --testPathPattern=auth.controller` | ❌ W0 | ⬜ pending |
| 19-02-02 | 02 | 1 | AUTH-002 | — | POST /auth/google/verify creates tenant+user on first sign-up | e2e | `npm test -- --testPathPattern=auth.controller` | ❌ W0 | ⬜ pending |
| 19-02-03 | 02 | 1 | AUTH-001 | — | POST /auth/logout clears session cookie | e2e | `npm test -- --testPathPattern=auth.controller` | ❌ W0 | ⬜ pending |
| 19-03-01 | 03 | 1 | AUTH-003 | — | POST /auth/onboarding returns 409 if already completed | e2e | `npm test -- --testPathPattern=auth.controller` | ❌ W0 | ⬜ pending |
| 19-03-02 | 03 | 1 | AUTH-005 | — | POST /auth/magic-link always returns 200 (no email enumeration) | e2e | `npm test -- --testPathPattern=auth.controller` | ❌ W0 | ⬜ pending |
| 19-03-03 | 03 | 1 | AUTH-005 | — | GET /auth/magic-link/verify validates token and sets session cookie | e2e | `npm test -- --testPathPattern=auth.controller` | ❌ W0 | ⬜ pending |
| 19-04-01 | 04 | 1 | AUTH-004 | — | GET /auth/invite/:token returns 404/409/410 for invalid states | e2e | `npm test -- --testPathPattern=auth.controller` | ❌ W0 | ⬜ pending |
| 19-04-02 | 04 | 1 | AUTH-004 | — | POST /auth/invite/:token/accept marks invitation accepted | e2e | `npm test -- --testPathPattern=auth.controller` | ❌ W0 | ⬜ pending |
| 19-05-01 | 05 | 2 | AUTH-006 | — | GET /auth/team/members returns active members for tenant | e2e | `npm test -- --testPathPattern=auth.controller` | ❌ W0 | ⬜ pending |
| 19-05-02 | 05 | 2 | AUTH-007 | — | POST /auth/team/invitations returns 409 on duplicate | e2e | `npm test -- --testPathPattern=auth.controller` | ❌ W0 | ⬜ pending |
| 19-05-03 | 05 | 2 | AUTH-007 | — | PATCH /auth/team/members/:id/role rejects non-Owner with 403 | e2e | `npm test -- --testPathPattern=auth.controller` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/auth/auth.controller.spec.ts` — stubs for all 14 endpoint tests (AUTH-001 through AUTH-007)
- [ ] `src/auth/session.guard.spec.ts` — stubs for SessionGuard unit tests (AUTH-001)
- [ ] `src/auth/email.service.spec.ts` — stubs for EmailService unit tests (AUTH-005)

*Existing Jest infrastructure covers the framework; only spec stubs need creating.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Google OAuth real token verification | AUTH-002 | Requires live Google credentials (GOOGLE_CLIENT_ID) not present in dev | Set GOOGLE_CLIENT_ID env, obtain real access_token, POST to /auth/google/verify |
| Magic link email delivery | AUTH-005 | Requires real SMTP server | Configure SMTP_HOST, trigger /auth/magic-link, check inbox |
| R2 logo upload in onboarding | AUTH-003 | Requires live R2 credentials | POST multipart to /auth/onboarding with logo file, verify R2 bucket |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
