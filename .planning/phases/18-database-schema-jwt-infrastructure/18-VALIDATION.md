---
phase: 18
slug: database-schema-jwt-infrastructure
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-09
---

# Phase 18 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property               | Value                                                                        |
| ---------------------- | ---------------------------------------------------------------------------- |
| **Framework**          | Jest 29.x (ts-jest)                                                          |
| **Config file**        | `package.json` (jest config inline)                                          |
| **Quick run command**  | `npm test -- --testPathPattern=jwt.service.spec --passWithNoTests=false`     |
| **Full suite command** | `npm test`                                                                   |
| **Estimated runtime**  | ~10–20 seconds (unit tests only; migration tasks require running containers) |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- --testPathPattern=jwt.service.spec --passWithNoTests=false`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~20 seconds

---

## Per-Task Verification Map

| Task ID  | Plan | Wave | Requirement                  | Threat Ref                         | Secure Behavior                                                                | Test Type       | Automated Command                                                        | File Exists | Status     |
| -------- | ---- | ---- | ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------ | ----------- | ---------- |
| 18-01-01 | 01   | 1    | UM-01, UM-02, UM-03          | T-18-02, T-18-04                   | role/auth_provider CHECK constraints enforced at DB level                      | schema-validate | `npx prisma validate`                                                    | ❌ W0       | ⬜ pending |
| 18-01-02 | 01   | 1    | UM-01, UM-02, UM-03, UM-04   | T-18-02, T-18-03, T-18-04, T-18-05 | Migrations additive only; no DROP on existing tables                           | migration       | `npm run db:migrate`                                                     | ❌ W0       | ⬜ pending |
| 18-01-03 | 01   | 1    | AUTH-01                      | T-18-01                            | JWT_SECRET validated at startup; async sign/verify with correct sub/org fields | unit            | `npm test -- --testPathPattern=jwt.service.spec --passWithNoTests=false` | ❌ W0       | ⬜ pending |
| 18-01-04 | 01   | 1    | AUTH-01                      | T-18-01                            | JwtService injectable via AuthModule                                           | build           | `npm run build 2>&1 \| grep -E "error\|Successfully compiled"`           | ❌ W0       | ⬜ pending |
| 18-01-05 | 01   | 1    | AUTH-01                      | T-18-01                            | JWT_SECRET min 32 chars enforced; app fails fast if missing                    | build           | `grep "JWT_SECRET" .env.example`                                         | ❌ W0       | ⬜ pending |
| 18-01-06 | 01   | 1    | UM-01, UM-02, UM-03, AUTH-01 | all                                | All existing v1.0 tests still pass; 6+ JWT tests green                         | unit            | `npm test`                                                               | ❌ W0       | ⬜ pending |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

---

## Wave 0 Requirements

- [ ] `src/auth/jwt.service.spec.ts` — 6 unit test stubs for JwtService (sign, verify, expired, tampered, signAccessToken, signRefreshToken)
- [ ] Jest `transformIgnorePatterns` extended to include `jose` (in `package.json`) — required for ESM compatibility in test environment

_Existing test infrastructure (Jest, ts-jest, @nestjs/testing) covers all other phase requirements._

---

## Manual-Only Verifications

| Behavior                                 | Requirement      | Why Manual                                                  | Test Instructions                                                                                                                                                                                                                                           |
| ---------------------------------------- | ---------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration 1 generates no destructive SQL | UM-02            | Must inspect generated SQL file before `npm run db:migrate` | After `npx prisma migrate dev --create-only --name rename_tenant_to_organization`, open the generated migration file and confirm it contains no `RENAME TO`, `DROP TABLE`, or `ALTER TABLE` on existing tables                                              |
| CHECK constraints enforced at DB level   | UM-03, T-18-04   | Requires running PostgreSQL container                       | `docker exec <pg-container> psql -U postgres -d talentdb -c "INSERT INTO users (id, email, auth_provider, organization_id, role) VALUES (gen_random_uuid(), 'x@x.com', 'password', '<org-id>', 'superadmin');"` — must fail with CHECK constraint violation |
| App fails fast on missing JWT_SECRET     | AUTH-01, T-18-01 | Requires container restart                                  | Remove JWT_SECRET from `.env`, run `npm run docker:up`, confirm container exits with config validation error                                                                                                                                                |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
