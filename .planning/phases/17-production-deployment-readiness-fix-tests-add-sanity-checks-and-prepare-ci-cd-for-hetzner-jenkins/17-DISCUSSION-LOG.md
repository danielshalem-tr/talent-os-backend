# Phase 17: Production Deployment Readiness — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-31
**Phase:** 17-production-deployment-readiness
**Areas discussed:** Local Docker UX, CI/CD pipeline, Test scope, Security hardening, Logging & Alerts, Database Backups, Resource Limits, API Endpoint Sanity, Health Check Endpoint, Scripts Cleanup, README

---

## Local Docker UX

| Option | Description | Selected |
|--------|-------------|----------|
| One command: docker compose up | Auto-migrate on start, seed included | |
| Makefile with targets | make up / make reset / make seed / make test etc. | ✓ |
| Keep current, just document it | Write README section, no new tooling | |

**User's choice:** Makefile with targets

| Option | Description | Selected |
|--------|-------------|----------|
| Dev compose (volume mount, hot reload) | docker-compose.dev.yml | ✓ |
| Prod compose (built image) | docker-compose.yml | |

**User's choice:** Dev compose is the local target

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-migrate on up, seed separate | make up migrates; make seed is opt-in | ✓ |
| All separate targets | up / migrate / seed all explicit | |
| Auto-migrate and auto-seed | make up does everything | |

**User's choice:** Auto-migrate on up, seed separate

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, make reset | docker compose down -v + make up | ✓ |
| No, keep it simple | Manual docker compose down -v | |

**User's choice:** Yes, make reset

---

## CI/CD Pipeline

| Option | Description | Selected |
|--------|-------------|----------|
| Build → Test → Push image → Deploy | Full CD pipeline | |
| Build → Test only (no auto-deploy) | CI validates, deploy is manual | ✓ |
| Test → Deploy (no image registry) | Build on server | |

**User's choice:** Build → Test only. Deploy remains a manual human action.

| Option | Description | Selected |
|--------|-------------|----------|
| .env file on server | Single .env on Hetzner VPS | |
| Jenkins credentials store | Secrets in Jenkins | |
| Environment-specific .env files | .env.prod, .env.stage per env | ✓ |

**User's choice:** Environment-specific .env files (.env.prod, .env.stage)

| Option | Description | Selected |
|--------|-------------|----------|
| Separate make target: make migrate-prod | Explicit human action | ✓ |
| Auto-migrate on container start | Entrypoint runs migrate | |

**User's choice:** make migrate-prod — never auto on prod container start

| Option | Description | Selected |
|--------|-------------|----------|
| prod only for now | One pipeline target | ✓ |
| prod + stage from day 1 | Branch-based env switch | |

**User's choice:** prod only for now

---

## Test Scope

| Option | Description | Selected |
|--------|-------------|----------|
| All tests green + E2E smoke test | Fix failing + add /health E2E test | ✓ |
| All unit tests green, no new tests | Fix failing only | |
| Full coverage push | Fix + fill coverage gaps | |

**User's choice:** All tests green + E2E smoke test for /health endpoint

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — tests run in Docker | make test uses Docker container | ✓ |
| No — tests run locally with npm test | Local Node only | |

**User's choice:** make test runs jest inside Docker

---

## Security Hardening

| Option | Description | Selected |
|--------|-------------|----------|
| Helmet (HTTP security headers) | @nestjs/helmet globally | ✓ |
| Rate limiting on webhook endpoint | @nestjs/throttler on POST /webhooks/email | ✓ |
| CORS lockdown | Default-deny cross-origin | ✓ |
| Secrets exposure audit | Review response fields + .gitignore | ✓ |

**User's choice:** All four security measures

---

## Logging & Alerts

| Option | Description | Selected |
|--------|-------------|----------|
| Structured JSON logs only | pino/NestJS JSON, no external service | ✓ |
| Structured logs + health endpoint | JSON logs + GET /health | |
| Full observability: logs + health + Sentry | Adds Sentry dependency | |

**User's choice:** Structured JSON logs (Sentry deferred)

| Option | Description | Selected |
|--------|-------------|----------|
| Log all BullMQ events | job started/completed/failed/retried | ✓ |
| Only on failure | Silent on success | |

**User's choice:** Log all BullMQ job lifecycle events

---

## Database Backups

| Option | Description | Selected |
|--------|-------------|----------|
| pg_dump script + Makefile target | make backup / make restore | ✓ |
| Hetzner snapshots only | Full-disk, no code changes | |
| Automated cron backup to R2 | Daily cron + R2 upload | |

**User's choice:** make backup (manual pg_dump) + make restore

| Option | Description | Selected |
|--------|-------------|----------|
| Makefile target: make restore | make restore BACKUP=./backups/dump.sql.gz | ✓ |
| README only | Document pg_restore command | |

**User's choice:** make restore Makefile target

---

## Resource Limits

| Option | Description | Selected |
|--------|-------------|----------|
| Set limits in prod compose | api/worker/postgres/redis all capped | ✓ |
| No limits for now | Add after seeing prod usage data | |
| Limits only on Worker | Worker capped, rest uncapped | |

**User's choice:** Set limits on all containers in docker-compose.yml
- api: 512MB / 0.5 CPU, worker: 768MB / 1 CPU, postgres: 1GB / 0.5 CPU, redis: 128MB / 0.25 CPU

| Option | Description | Selected |
|--------|-------------|----------|
| restart: unless-stopped | Auto-restart all containers | ✓ |
| No restart policy | Manual restart | |

**User's choice:** restart: unless-stopped on all containers

---

## API Endpoint Sanity Review

*User-initiated area: "I suspect the API level is not stable right now"*

| Option | Description | Selected |
|--------|-------------|----------|
| Full contract review + fix bugs found | Read all controllers/services, fix bugs | ✓ |
| Smoke test each endpoint | Test script hitting all endpoints | |
| Review only, document findings | No fixes in this phase | |

**User's choice:** Full review + fix all bugs found

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — verify PROTOCOL.md alignment | Match every response to spec | ✓ |
| No — just functional correctness | Skip field naming verification | |

**User's choice:** Full PROTOCOL.md alignment verification

---

## Health Check Endpoint

| Option | Description | Selected |
|--------|-------------|----------|
| With DB + Redis probe | { status, checks, uptime } / 503 on fail | ✓ |
| Simple ping only | Always 200 if app boots | |

**User's choice:** GET /health with DB + Redis liveness probes, 503 on degraded

---

## Scripts Cleanup

| Option | Description | Selected |
|--------|-------------|----------|
| ngrok-webhook.sh | Add comments + make ngrok alias | ✓ |
| npm scripts cleanup | Consolidate duplicate db:setup variants | ✓ |
| Add deploy script | scripts/deploy.sh for Jenkins | ✓ |

**User's choice:** All three cleanup tasks

---

## README

| Option | Description | Selected |
|--------|-------------|----------|
| Complete developer README | Full onboarding doc with all sections | ✓ |
| Minimal — just update existing | Only add new Makefile targets | |

**User's choice:** Complete developer README rewrite

---

## Claude's Discretion

- Exact JSON logger library (pino vs NestJS built-in)
- Health check implementation (Terminus vs custom controller)
- Throttler rate limit numbers
- Exact Jenkinsfile agent/label configuration

## Deferred Ideas

- Sentry integration — mentioned in PROJECT.md but not in Phase 17 scope
- Hetzner VPS / Jenkins server provisioning — Phase 17 creates artifacts only
- Stage / QA environments — added to Jenkinsfile later
- Automated cron backup to R2 — Phase 2+ ops
