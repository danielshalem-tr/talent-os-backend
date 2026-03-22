---
phase: 2
slug: webhook
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-22
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Jest 30.0.0 (configured in package.json) |
| **Config file** | jest.config.js (falls back to package.json jest config) |
| **Quick run command** | `npm test -- src/webhooks/` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- src/webhooks/`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 2-xx-01 | TBD | 0 | WBHK-01 | integration | `npm test -- src/webhooks/webhooks.controller.spec.ts -t "accepts webhook and responds 200"` | ❌ W0 | ⬜ pending |
| 2-xx-02 | TBD | 0 | WBHK-02 | unit | `npm test -- src/webhooks/guards/postmark-auth.guard.spec.ts -t "rejects invalid signature"` | ❌ W0 | ⬜ pending |
| 2-xx-03 | TBD | 0 | WBHK-03 | unit | `npm test -- src/webhooks/webhooks.service.spec.ts -t "idempotent on duplicate messageId"` | ❌ W0 | ⬜ pending |
| 2-xx-04 | TBD | 0 | WBHK-04 | unit | `npm test -- src/webhooks/webhooks.service.spec.ts -t "inserts intake_log before enqueue"` | ❌ W0 | ⬜ pending |
| 2-xx-05 | TBD | 0 | WBHK-05 | unit | `npm test -- src/webhooks/webhooks.service.spec.ts -t "enqueues with correct retry config"` | ❌ W0 | ⬜ pending |
| 2-xx-06 | TBD | 0 | WBHK-06 | unit | `npm test -- src/webhooks/webhooks.service.spec.ts -t "strips attachment blobs, keeps metadata"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/webhooks/webhooks.controller.spec.ts` — controller integration tests (WBHK-01, idempotency)
- [ ] `src/webhooks/guards/postmark-auth.guard.spec.ts` — guard unit tests (WBHK-02)
- [ ] `src/webhooks/webhooks.service.spec.ts` — service unit tests (WBHK-03 through WBHK-06)
- [ ] `src/webhooks/dto/postmark-payload.dto.spec.ts` — DTO validation tests

*Framework: jest 30.0.0 already in package.json — no install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| POST /webhooks/email responds within 100ms end-to-end | WBHK-01 | Requires live DB + Redis; timing varies in unit tests | `curl -w "%{time_total}" -X POST http://localhost:3000/webhooks/email -H "Content-Type: application/json" -d @test/fixtures/postmark-sample.json` — time_total must be < 0.1s |
| HTTP Basic Auth header accepted by Postmark | WBHK-02 | Postmark-specific auth method requires real webhook URL | Set webhook URL in Postmark dashboard with `https://user:token@host/webhooks/email`, verify 200 in Postmark logs |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
