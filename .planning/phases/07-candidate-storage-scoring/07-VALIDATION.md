---
phase: 7
slug: candidate-storage-scoring
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-23
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | jest 29.x |
| **Config file** | jest.config.js |
| **Quick run command** | `npx jest --testPathPattern="scoring" --no-coverage` |
| **Full suite command** | `npx jest --no-coverage` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx jest --testPathPattern="scoring" --no-coverage`
- **After every plan wave:** Run `npx jest --no-coverage`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 7-01-01 | 01 | 1 | CAND-01 | unit | `npx jest --testPathPattern="scoring.service" --no-coverage` | ❌ W0 | ⬜ pending |
| 7-01-02 | 01 | 1 | CAND-02 | integration | `npx jest --testPathPattern="scoring.service" --no-coverage` | ❌ W0 | ⬜ pending |
| 7-01-03 | 01 | 1 | CAND-03 | unit | `npx jest --testPathPattern="scoring.service" --no-coverage` | ❌ W0 | ⬜ pending |
| 7-02-01 | 02 | 1 | SCOR-01 | unit | `npx jest --testPathPattern="scoring.service" --no-coverage` | ❌ W0 | ⬜ pending |
| 7-02-02 | 02 | 1 | SCOR-02 | unit | `npx jest --testPathPattern="scoring.service" --no-coverage` | ❌ W0 | ⬜ pending |
| 7-02-03 | 02 | 2 | SCOR-03 | unit | `npx jest --testPathPattern="scoring.service" --no-coverage` | ❌ W0 | ⬜ pending |
| 7-02-04 | 02 | 2 | SCOR-04 | unit | `npx jest --testPathPattern="scoring.service" --no-coverage` | ❌ W0 | ⬜ pending |
| 7-02-05 | 02 | 2 | SCOR-05 | unit | `npx jest --testPathPattern="scoring.service" --no-coverage` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/scoring/scoring.service.spec.ts` — stubs for CAND-01, CAND-02, CAND-03, SCOR-01–SCOR-05
- [ ] Existing test infrastructure (jest.config.js, tsconfig) covers all needs — no new framework install

*Existing infrastructure covers most phase requirements; only new spec file needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| CAND-02 partial index present in DB | CAND-02 | Requires DB migration inspection | Check `prisma/migrations/` for `CREATE UNIQUE INDEX ... WHERE email IS NOT NULL` |
| Scoring actually calls Claude Sonnet API | SCOR-01 | Integration with live API | In integration test, verify `model_used` column = `claude-sonnet-*` in DB |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
