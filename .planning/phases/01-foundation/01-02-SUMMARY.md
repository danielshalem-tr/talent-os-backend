---
phase: 01-foundation
plan: 02
subsystem: database
tags: [prisma, postgresql, migrations, pg_trgm, schema, seed]

# Dependency graph
requires:
  - 01-01 (PrismaService + bootstrap)
provides:
  - Complete 7-table Prisma schema (single source of truth)
  - Initial migration with pg_trgm extension + GIN indexes + CHECK constraints
  - Idempotent seed: 1 tenant (Triolla) + 1 active job (Software Engineer)
  - docker-compose.yml with postgres:16-alpine + redis:7-alpine
affects: [03-webhook, 04-extraction, 05-file-storage, 06-dedup, 07-scoring]

# Tech tracking
tech-stack:
  added:
    - "postgres:16-alpine (Docker)"
    - "redis:7-alpine (Docker)"
    - "pg_trgm extension (PostgreSQL)"
  patterns:
    - "Migration with appended raw SQL for features Prisma DSL cannot express (GIN indexes, partial indexes, CHECK constraints)"
    - "Idempotent seed via prisma.upsert() with hardcoded deterministic UUIDs (00000000-...0001 tenant, 00000000-...0002 job)"
    - "text + CHECK constraint over PostgreSQL ENUM for all status/type columns (avoids migration cost to add new values)"

key-files:
  created:
    - prisma/migrations/20260322110817_init/migration.sql
    - prisma/seed.ts
    - docker-compose.yml
    - .env.example
  modified:
    - prisma/schema.prisma
    - package.json

key-decisions:
  - "Appended raw SQL to Prisma-generated migration: pg_trgm, GIN indexes, partial indexes, CHECK constraints — Prisma DSL cannot express partial indexes or GIN operators"
  - "Used DO block with pg_constraint check for idempotent constraint creation in dev DB after migration was already applied"
  - "docker-compose.yml exposes ports 5432 and 6379 locally for direct dev access (removed in production)"

patterns-established:
  - "Pattern 4: Raw SQL appended to Prisma migration — place Prisma-incompatible SQL at end of generated migration.sql, after all Prisma DDL"

requirements-completed: [DB-01, DB-02, DB-03, DB-04, DB-05, DB-06, DB-07, DB-08, DB-09]

# Metrics
duration: 8min
completed: 2026-03-22
---

# Phase 01 Plan 02: Database Schema + Migration Summary

**7-table Prisma schema with pg_trgm GIN indexes, partial indexes, text+CHECK constraints, and idempotent seed — all applied to live PostgreSQL 16 via docker-compose**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-03-22T11:02:51Z
- **Completed:** 2026-03-22T11:10:31Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- All 7 Prisma models defined: Tenant, Job, Candidate, Application, CandidateJobScore, DuplicateFlag, EmailIntakeLog
- tenant_id FK on all 6 non-Tenant models (DB-02)
- Zero Prisma enums — all status/type columns use `text` (DB-03)
- @updatedAt on Job, Candidate, Application (DB-04)
- cv_file_url as String? — no Bytes (DB-05)
- @@unique on applications, duplicate_flags, email_intake_log (DB-06/07/08)
- Initial migration applied to live PostgreSQL 16 container
- pg_trgm extension enabled, GIN indexes on candidates.full_name and candidates.phone
- Partial unique index idx_candidates_email (tenant_id, email) WHERE email IS NOT NULL
- CHECK constraints on all status/type columns (DB-03)
- prisma/seed.ts: upserts tenant 00000000-...-0001 and job 00000000-...-0002 idempotently
- docker-compose.yml: postgres + redis with local port exposure
- .env.example documenting all 10 required env vars

## Task Commits

1. **Task 1: Write prisma/schema.prisma with all 7 models** - `80d328b` (feat)
2. **Task 2: Migration + pg_trgm indexes + seed** - `558ab54` (feat)
3. **.env.example** - `6f63982` (chore)

## Files Created/Modified

- `prisma/schema.prisma` - 7 models, all relationships, @@unique constraints, no enums
- `prisma/migrations/20260322110817_init/migration.sql` - Prisma DDL + raw SQL appended for pg_trgm, GIN indexes, partial indexes, CHECK constraints
- `prisma/migrations/migration_lock.toml` - Prisma migration lock
- `prisma/seed.ts` - Idempotent upsert: 1 tenant (Triolla) + 1 active job (Software Engineer)
- `package.json` - Added `"prisma": { "seed": "ts-node prisma/seed.ts" }`
- `docker-compose.yml` - postgres:16-alpine + redis:7-alpine with port mapping
- `.env.example` - All 10 required env vars documented

## Decisions Made

- **Raw SQL appended to Prisma migration:** Prisma DSL has no syntax for GIN indexes, partial indexes, or `ALTER TABLE ... ADD CONSTRAINT`. All such statements appended after the Prisma-generated DDL in migration.sql.
- **DO block for idempotent constraint creation:** After migration was applied, added CHECK constraints using `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '...') THEN ... END IF; END $$;` to avoid "constraint already exists" errors.
- **docker-compose.yml created as deviation:** The spec defines a docker-compose.yml but plan 01-02 didn't explicitly create it. Required for running `prisma migrate dev`. Created as Rule 3 auto-fix (blocking issue).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] docker-compose.yml missing — required for prisma migrate dev**
- **Found during:** Task 2 (attempting to run migration)
- **Issue:** No Docker Compose file existed; plan assumed postgres was already running but it wasn't
- **Fix:** Created docker-compose.yml from spec §10 (postgres:16-alpine + redis:7-alpine) and started postgres container
- **Files modified:** docker-compose.yml (new)
- **Commit:** 558ab54

**2. [Rule 1 - Bug] `ALTER TABLE ADD CONSTRAINT IF NOT EXISTS` syntax not supported in PostgreSQL 16**
- **Found during:** Task 2 (applying CHECK constraints to live DB)
- **Issue:** PostgreSQL 16 does not support `IF NOT EXISTS` on `ADD CONSTRAINT`; only on CREATE INDEX
- **Fix:** Used `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint ...) THEN ALTER TABLE ... END IF; END $$;` pattern for idempotent constraint creation in dev DB
- **Files modified:** None (DB-only fix; migration.sql uses correct single-run syntax without IF NOT EXISTS)
- **Committed in:** 558ab54

**3. [Rule 2 - Missing] .env file required for prisma CLI to connect**
- **Found during:** Task 2 (running prisma migrate dev)
- **Issue:** No .env file existed; prisma needs DATABASE_URL
- **Fix:** Created .env (gitignored) with local dev values + .env.example for documentation
- **Files modified:** .env (gitignored), .env.example
- **Commit:** 6f63982

## Self-Check: PASSED

- prisma/schema.prisma: FOUND
- prisma/migrations/20260322110817_init/migration.sql: FOUND
- prisma/seed.ts: FOUND
- docker-compose.yml: FOUND
- .env.example: FOUND
- commit 80d328b: FOUND
- commit 558ab54: FOUND
- commit 6f63982: FOUND

---
*Phase: 01-foundation*
*Completed: 2026-03-22*
