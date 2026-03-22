---
phase: 1
slug: foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-22
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                                 |
| ---------------------- | ----------------------------------------------------- |
| **Framework**          | Jest 30.0.0 (pre-installed)                           |
| **Config file**        | `package.json` (jest key) + `test/jest-e2e.json`      |
| **Quick run command**  | `npm test -- --testPathPattern="src/" --maxWorkers=2` |
| **Full suite command** | `npm run test:cov`                                    |
| **Estimated runtime**  | ~10 seconds (unit), ~30 seconds (full)                |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- --testPathPattern="src/" --maxWorkers=2`
- **After every plan wave:** Run `npm run test:cov`
- **Before `/gsd:verify-work`:** Full suite must be green + docker-compose e2e test
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement         | Test Type    | Automated Command                                                  | File Exists | Status     |
| ------- | ---- | ---- | ------------------- | ------------ | ------------------------------------------------------------------ | ----------- | ---------- |
| 1-01-01 | 01   | 0    | INFR-03             | unit         | `npm test -- --testPathPattern="config" -x`                        | ❌ W0       | ⬜ pending |
| 1-01-02 | 01   | 0    | DB-01, DB-04        | integration  | `npm test -- --testPathPattern="prisma.service" -x`                | ❌ W0       | ⬜ pending |
| 1-01-03 | 01   | 0    | INFR-01             | unit         | `npm test -- --testPathPattern="main" -x`                          | ❌ W0       | ⬜ pending |
| 1-01-04 | 01   | 0    | INFR-02             | integration  | `npm test -- --testPathPattern="worker" -x`                        | ❌ W0       | ⬜ pending |
| 1-02-01 | 02   | 1    | DB-01..09           | integration  | `npm test -- --testPathPattern="prisma" -x`                        | ❌ W0       | ⬜ pending |
| 1-02-02 | 02   | 1    | DB-06, DB-07, DB-08 | integration  | `npm test -- --testPathPattern="applications\|dedup\|webhooks" -x` | ❌ W0       | ⬜ pending |
| 1-03-01 | 03   | 2    | INFR-04, PROC-01    | e2e (manual) | `docker-compose up --wait && docker-compose ps`                    | N/A         | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] `src/config/env.ts` + `src/config/env.spec.ts` — Zod schema with validation tests (covers INFR-03)
- [ ] `src/prisma/prisma.service.ts` + `src/prisma/prisma.service.spec.ts` — PrismaService initialization tests (covers DB-01, DB-04)
- [ ] `src/main.ts` + `src/main.spec.ts` — rawBody: true configuration test (covers INFR-01)
- [ ] `src/worker.ts` + `src/worker.spec.ts` — Worker bootstrap (no HTTP) test (covers INFR-02)

_Existing Jest infrastructure covers all framework requirements — no install needed._

---

## Manual-Only Verifications

| Behavior                                               | Requirement | Why Manual             | Test Instructions                                                                                                            |
| ------------------------------------------------------ | ----------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Status columns use CHECK constraints, not ENUMs        | DB-03       | Schema inspection only | `cat prisma/schema.prisma` and confirm no `enum` blocks for status fields                                                    |
| No binary blobs in DB (cv_file_url is text, not bytea) | DB-05       | Schema inspection only | `cat prisma/schema.prisma` and confirm `cv_file_url String` not `Bytes`                                                      |
| All pg_trgm GIN indexes created                        | DB-09       | Requires live DB       | `docker-compose exec postgres psql -U postgres -c '\d candidates'`                                                           |
| `.env.example` has all required vars                   | INFR-05     | File inspection        | `cat .env.example` and confirm DATABASE*URL, REDIS_URL, POSTMARK_WEBHOOK_SECRET, ANTHROPIC_API_KEY, R2*\*, TENANT_ID present |
| All 4 Docker services start healthy                    | INFR-04     | Docker orchestration   | `docker-compose up --wait && docker-compose ps` — all must show "healthy"                                                    |
| API and Worker in separate containers                  | PROC-01     | Docker orchestration   | `docker-compose ps` shows both `api` and `worker` containers running                                                         |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
