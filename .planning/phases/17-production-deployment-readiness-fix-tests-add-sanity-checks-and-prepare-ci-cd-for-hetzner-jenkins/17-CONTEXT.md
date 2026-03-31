# Phase 17: Production Deployment Readiness — Context

**Gathered:** 2026-03-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Close out the v1.0 milestone by hardening the codebase for production: fix all failing tests, add runtime sanity checks (health endpoint + structured logging), tighten security (helmet, rate limiting, CORS, secrets audit), simplify local Docker workflow with a Makefile, lay CI/CD groundwork (Jenkinsfile + deploy script), add DB backup/restore scripts, set container resource limits, audit and fix all API endpoints against PROTOCOL.md, and produce a complete developer README.

**This phase does NOT set up the Jenkins server or Hetzner VPS — it produces the artifacts (Jenkinsfile, deploy script, Makefile, .env.prod.example) that make that setup straightforward.**

</domain>

<decisions>
## Implementation Decisions

### Local Docker Workflow
- **D-01:** Add a `Makefile` with these targets:
  - `make up` — runs `docker compose -f docker-compose.dev.yml up` and waits for DB healthy, then auto-runs `prisma migrate deploy`
  - `make down` — stops containers
  - `make reset` — `docker compose down -v` + `make up` (wipes postgres_data and redis_data volumes, fresh start)
  - `make seed` — runs `prisma db seed` inside the API container (explicit, opt-in)
  - `make logs` — `docker compose logs -f`
  - `make test` — runs jest inside a Docker container (no local Node required, matches CI)
  - `make backup` — pg_dump from postgres container to `./backups/` as `.sql.gz`
  - `make restore BACKUP=./backups/dump.sql.gz` — restores DB from dump file
  - `make ngrok` — runs `scripts/ngrok-webhook.sh`
  - `make migrate-prod` — SSH helper that runs `prisma migrate deploy` on prod server
- **D-02:** Local target is `docker-compose.dev.yml` (volume mount, hot reload, ts-node worker). Dev compose is the primary local workflow.
- **D-03:** `make up` auto-migrates. Seed is separate (`make seed`). `make reset` for clean-slate testing.

### CI/CD Pipeline (Jenkins)
- **D-04:** Create a `Jenkinsfile` at project root with stages: **Build → Test** only (no auto-deploy). Deploy is a manual human action.
- **D-05:** Pipeline stages:
  1. `npm ci`
  2. `npm run build`
  3. `npm run test` (unit tests must pass as CI gate)
  4. `docker build` (verifies the image builds cleanly)
- **D-06:** Secrets managed via environment-specific `.env` files on the server (`.env.prod`, `.env.stage` when infra exists). Not in git. Jenkins does not inject secrets.
- **D-07:** Migrations run via `make migrate-prod` — a separate explicit Makefile target, never automatic on container start. Human triggers it before/after deploy.
- **D-08:** Jenkinsfile supports `prod` only for now. Stage/QA added later when those servers exist.
- **D-09:** Create `scripts/deploy.sh` — SSH to Hetzner, `git pull`, `docker compose -f docker-compose.yml up -d --build`. Referenced from Jenkinsfile but not auto-triggered by CI.

### Test Coverage
- **D-10:** All currently-failing unit tests must be fixed (6 modified files from Phase 16 work, including `ingestion.processor.spec.ts`).
- **D-11:** Add an E2E smoke test (`test/app.e2e-spec.ts`) that boots the NestJS app and hits `GET /health` — verifies the app starts without crashes. `npm run test:e2e` must pass.
- **D-12:** `make test` runs `npm run test` inside a Docker container (same environment as Jenkins). Both unit and E2E pass with 0 failures.
- **D-13:** No full coverage push — fix what's broken + the health endpoint E2E. Scope is milestone close, not comprehensive coverage expansion.

### Security Hardening
- **D-14:** Add `@nestjs/helmet` — sets standard HTTP security headers (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Content-Security-Policy). Applied globally in `main.ts`.
- **D-15:** Add `@nestjs/throttler` — rate limit `POST /webhooks/email` endpoint. Prevents abuse if webhook token is exposed.
- **D-16:** Configure CORS — the API only receives Postmark webhooks (no browser clients in Phase 1). Set CORS to deny all cross-origin by default, or restrict to known origins.
- **D-17:** Secrets exposure audit — review all API responses to confirm: no raw `tenant_id` UUIDs leak, no stack traces in error responses, `.gitignore` covers all `.env*` files, no sensitive fields in logged output.

### API Endpoint Sanity Review
- **D-18:** Full code review of all controllers and services: `jobs`, `candidates`, `applications`, `webhooks`, `ingestion`. Check for: unguarded errors, missing validation, broken responses, incorrect HTTP status codes, missing tenant isolation.
- **D-19:** Verify every endpoint's JSON response shape (field names, nesting, types) matches `PROTOCOL.md`. Fix any drift. snake_case vs camelCase consistency.
- **D-20:** Fix all bugs found during the review. Document any remaining known issues.

### Health Check Endpoint
- **D-21:** Add `GET /health` endpoint that probes DB + Redis:
  ```json
  {
    "status": "ok" | "degraded",
    "checks": { "database": "ok" | "fail", "redis": "ok" | "fail" },
    "uptime": 12345
  }
  ```
  Returns `200` if healthy, `503` if any check fails.
- **D-22:** Add Docker healthcheck in `docker-compose.yml` for the `api` service using `GET /health`.

### Structured Logging
- **D-23:** Replace NestJS default logger with JSON-structured output (pino or NestJS built-in JSON mode). Every log entry has: `level`, `timestamp`, `context`, `message`.
- **D-24:** Worker logs all BullMQ job lifecycle events: job started, completed, failed, retried — including `job.id`, `job.name`, `tenant_id`, and outcome. Essential for tracing why a CV wasn't processed.

### Database Backups
- **D-25:** `make backup` runs `pg_dump` inside the postgres container, saves to `./backups/YYYY-MM-DD_HH-MM.sql.gz`. The `backups/` directory is gitignored.
- **D-26:** `make restore BACKUP=./backups/dump.sql.gz` drops and re-creates the DB from a dump file. Documented for disaster recovery drills.

### Container Resource Limits
- **D-27:** Set memory/CPU limits in `docker-compose.yml` (prod) for Hetzner CX21 (2 vCPU, 4GB RAM):
  - `api`: 512MB RAM / 0.5 CPU
  - `worker`: 768MB RAM / 1 CPU (scoring is memory-heavier)
  - `postgres`: 1GB RAM / 0.5 CPU
  - `redis`: 128MB RAM / 0.25 CPU
- **D-28:** Verify `restart: unless-stopped` is set on ALL containers in `docker-compose.yml` (API, Worker, Postgres, Redis).

### Scripts Cleanup
- **D-29:** `scripts/ngrok-webhook.sh` — add usage comments, add `make ngrok` as a Makefile alias.
- **D-30:** Consolidate duplicate npm scripts: `db:setup:local` and `db:setup` do similar things — keep one clear variant per purpose, remove confusion.
- **D-31:** Create `scripts/deploy.sh` for prod deployment (SSH + docker compose pull + up).

### README
- **D-32:** Rewrite `README.md` as a complete developer onboarding doc covering:
  - Prerequisites (Docker, Make)
  - Quick start (`make up` then `make seed`)
  - Environment variables table (all vars from `.env.example` with descriptions)
  - Makefile targets reference
  - Common troubleshooting (DB not starting, migrations fail, etc.)
  - Deploy procedure (manual: `make deploy` or SSH + `scripts/deploy.sh`)

### Claude's Discretion
- Exact pino/winston configuration vs NestJS built-in JSON logger — use whichever integrates cleanest
- Health check implementation pattern (Terminus vs custom controller)
- Throttler configuration (exact rate limit numbers for webhook endpoint)
- Exact Jenkinsfile agent/label configuration (depends on Jenkins server setup)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### API Contract
- `PROTOCOL.md` — Full REST API contract. Every endpoint response shape, field names, status codes. D-19 requires alignment verification against this file.

### Infrastructure
- `docker-compose.yml` — Production compose (to add resource limits, healthcheck, restart policies)
- `docker-compose.dev.yml` — Dev compose (Makefile wraps this for local workflow)
- `Dockerfile` — Multi-stage build (builder + runner). Already working; verify healthcheck CMD added.
- `.env.example` — All required environment variables. Reference for README env vars table.

### Tests (current state)
- `src/ingestion/ingestion.processor.spec.ts` — Heavily modified in Phase 16 (174 lines changed). Primary failing test file to fix.
- `src/candidates/candidates.module.ts` — Modified in Phase 16 (unstaged).
- `src/ingestion/ingestion.processor.ts` — Modified in Phase 16 (unstaged).
- `src/jobs/dto/create-job.dto.ts` — Modified in Phase 16 (unstaged).
- `test/app.e2e-spec.ts` — Existing E2E test file. Add health endpoint smoke test here.
- `test/jest-e2e.json` — E2E Jest config.

### Scripts
- `scripts/ngrok-webhook.sh` — Existing ngrok script to clean up and document.

### Phase Context
- `.planning/phases/16-backend-support-for-manual-routing-ui-parity/16-CONTEXT.md` — Phase 16 decisions, especially CandidateResponse flattened format and shortId/sourceAgency fields.

No external specs beyond PROTOCOL.md — requirements are captured in decisions above.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Docker Compose setup:** Two compose files already work. Phase 17 extends them (resource limits, healthcheck) rather than replacing.
- **Existing npm scripts:** `docker:dev`, `docker:dev:build`, `docker:down`, `db:migrate:local`, `db:setup` — Makefile wraps these with cleaner names.
- **`test/app.e2e-spec.ts`:** Existing E2E file. Add health endpoint test here rather than creating a new file.
- **`main.ts`:** NestJS bootstrap with `rawBody: true`. Add helmet + CORS + throttler configuration here.

### Established Patterns
- **Error responses:** `BadRequestException` with `{ error: { code, message, details } }` format — verify all endpoints follow this.
- **Tenant isolation:** All service queries filter by `ConfigService.get('TENANT_ID')` — verify no endpoint leaks cross-tenant data.
- **Env validation:** `@nestjs/config` + Zod at startup — new env vars (if any) must follow this pattern.

### Integration Points
- **Health endpoint:** New `HealthModule` / `HealthController` — connects to `PrismaService` and Redis client for liveness probes.
- **Helmet/throttler:** Applied globally in `AppModule` imports and `main.ts` middleware.
- **BullMQ worker logging:** `ingestion.processor.ts` — add lifecycle event logging without changing job logic.

### Known Issues (Phase 16 unstaged changes)
- 6 files with unstaged changes from Phase 16 work. These need to be reviewed and committed as part of Phase 17 test-fixing work.
- `ingestion.processor.spec.ts` has 174 lines of changes — likely tests broken by Phase 16 refactoring.

</code_context>

<specifics>
## Specific Ideas

- The user explicitly flagged that the API layer may be unstable: "I suspect the API level is not stable right now" — endpoint review + PROTOCOL.md alignment is a priority item, not just a nice-to-have.
- `make reset` is essential for clean local testing — wipes volumes so every developer can start from a known state.
- Migrations must NEVER run automatically on prod container start — only via explicit `make migrate-prod` human action.
- Jenkins pipeline is Build → Test only. No auto-deploy in Phase 17. Deploy remains a manual SSH action.
- CORS should default-deny (API only talks to Postmark webhooks, no browser clients in Phase 1).

</specifics>

<deferred>
## Deferred Ideas

- **Sentry error monitoring** — PROJECT.md mentions it as recommended but non-blocking. Not in Phase 17 scope.
- **Hetzner VPS setup / Jenkins server configuration** — Phase 17 produces artifacts (Jenkinsfile, deploy.sh) but does not provision servers.
- **Stage / QA environments** — Jenkinsfile supports prod only. Stage/QA added when those servers exist.
- **Automated cron backup to R2** — Phase 17 adds `make backup` (manual). Automated scheduled backup is Phase 2+ ops work.
- **Bulk assignment endpoint** — Deferred from Phase 16.
- **Environment file strategy (.env.local.example, .env.prod.example)** — Not discussed; `.env.example` covers both. If needed, add in a future ops phase.

</deferred>

---

*Phase: 17-production-deployment-readiness-fix-tests-add-sanity-checks-and-prepare-ci-cd-for-hetzner-jenkins*
*Context gathered: 2026-03-31 (discuss mode)*
