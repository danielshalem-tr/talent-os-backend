---
phase: quick
plan: 260412-9rb
subsystem: auth/email
tags: [email, resend, nodemailer, smtp, refactor]
dependency_graph:
  requires: []
  provides: [resend-email-transport]
  affects: [src/auth/email.service.ts, src/config/env.ts]
tech_stack:
  added: [resend]
  patterns: [optional-sdk-instantiation, dev-log-fallback]
key_files:
  created: []
  modified:
    - src/auth/email.service.ts
    - src/config/env.ts
    - src/auth/email.service.spec.ts
    - package.json
    - package-lock.json
decisions:
  - Resend SDK instantiated to null when RESEND_API_KEY absent — dev fallback logs email body (D-12 pattern preserved)
  - RESEND_FROM optional in env schema; default noreply@talentos.triolla.io kept in service code
  - SMTP_* vars fully removed from env schema; no migration shim needed
metrics:
  duration: ~5 minutes
  completed: 2026-04-12
  tasks_completed: 3
  files_modified: 5
---

# Quick Task 260412-9rb: Use Resend Instead of Nodemailer/SMTP

**One-liner:** Swapped nodemailer SMTP transport for Resend SDK with optional-key dev fallback and SMTP env var removal.

## What Was Done

Replaced `nodemailer` with the `resend` npm package in EmailService. The service now instantiates a `Resend` client when `RESEND_API_KEY` is present in env, and falls back to logging email content when it is absent (preserving the D-12 dev fallback pattern). All three public method signatures (`sendInvitationEmail`, `sendMagicLinkEmail`, `sendUseGoogleEmail`) are unchanged.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Swap nodemailer for resend in package.json | 963d4ac | package.json, package-lock.json |
| 2 | Rewrite EmailService using Resend SDK | 86f1950 | src/auth/email.service.ts |
| 3 | Update env schema — remove SMTP_*, add RESEND_API_KEY | fa20d7a | src/config/env.ts, src/auth/email.service.spec.ts |

## Deviations from Plan

**1. [Rule 2 - Missing] Updated stale todo descriptions in email.service.spec.ts**
- Found during: Task 3
- Issue: Two `.todo` test descriptions still referenced `SMTP_HOST` and `nodemailer.sendMail` after the implementation switch
- Fix: Updated descriptions to reference `RESEND_API_KEY` and `resend.emails.send`
- Files modified: src/auth/email.service.spec.ts
- Commit: fa20d7a

## Pre-existing Issues (Out of Scope)

3 failing tests in `invitation.service.spec.ts` around `this.redis.getdel` — confirmed pre-existing before this task's changes. Not introduced by this task.

## Verification

- `npm test`: 310 passed, 3 pre-existing failures (unrelated to this task), 0 new failures
- `npx tsc --noEmit`: 2 pre-existing type errors in ingestion.processor.spec.ts (unrelated), 0 errors in email.service.ts
- `grep -r "nodemailer" src/`: exit 1 — no references
- `grep "resend" src/auth/email.service.ts`: import + client + send call all present
- env.spec.ts: 5/5 tests pass

## Known Stubs

None.

## Threat Flags

None — RESEND_API_KEY is never logged; the dev fallback logs only `to`, `subject`, and `text` (email body content already visible to recruiter). The `from` address is server-controlled via `RESEND_FROM` env var, not caller-supplied (T-9rb-02 mitigated).

## Self-Check: PASSED

- src/auth/email.service.ts: present
- src/config/env.ts: present
- Commits 963d4ac, 86f1950, fa20d7a: all exist in git log
