# Triolla Talent OS — Backend

Automated email intake pipeline: receives CVs via Postmark webhooks, extracts candidate data using AI, deduplicates, scores against open positions, stores in PostgreSQL.

## Prerequisites

- **Docker** 24+ and **Docker Compose** v2+
- **Make** (usually pre-installed on macOS/Linux; on macOS: `xcode-select --install`)
- **ngrok** (optional, for local Postmark webhook testing — `brew install ngrok`)

## Quick Start

1. Clone the repository
2. Copy environment variables: `cp .env.example .env`
3. Fill in required secrets in `.env` (see [Environment Variables](#environment-variables))
4. Start the stack: `make up`
5. Seed test data: `make seed`
6. API available at: `http://localhost:3000/api`

## Environment Variables

| Variable                 | Required | Description                                                                   |
| ------------------------ | -------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`           | Yes      | PostgreSQL connection string. Format: `postgresql://user:pass@host:5432/db`   |
| `REDIS_URL`              | Yes      | Redis connection string. Format: `redis://host:6379`                          |
| `OPENROUTER_API_KEY`     | Yes      | OpenRouter API key for openai/gpt-4o-mini (extraction and scoring)            |
| `POSTMARK_WEBHOOK_TOKEN` | Yes      | Token from Postmark Inbound webhook settings (used for HTTP Basic Auth guard) |
| `TENANT_ID`              | Yes      | UUID of the tenant record in the `tenants` table. Run `make seed` to create.  |
| `R2_ACCOUNT_ID`          | Yes      | Cloudflare R2 account ID (from Cloudflare dashboard → R2 → Manage API Tokens) |
| `R2_ACCESS_KEY_ID`       | Yes      | Cloudflare R2 access key ID                                                   |
| `R2_SECRET_ACCESS_KEY`   | Yes      | Cloudflare R2 secret access key                                               |
| `R2_BUCKET_NAME`         | Yes      | Cloudflare R2 bucket name for CV file storage (e.g. `triolla-cvs`)            |
| `POSTGRES_PASSWORD`      | Yes      | PostgreSQL superuser password (used by docker-compose.yml postgres service)   |
| `NODE_ENV`               | No       | `development` (default) or `production`                                       |

> All required variables are listed in `.env.example`. Copy it and fill in secrets — do not commit `.env` to git.

## Makefile Targets

| Target                            | Description                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `make up`                         | Start dev stack, wait for DB healthy, run migrations automatically                  |
| `make down`                       | Stop dev stack                                                                      |
| `make reset`                      | Wipe all volumes and restart fresh (clean-slate testing)                            |
| `make seed`                       | Seed DB with test jobs and candidate (opt-in)                                       |
| `make logs`                       | Follow all container logs                                                           |
| `make test`                       | Run unit tests inside Docker (matches CI environment)                               |
| `make backup`                     | Dump DB to `./backups/YYYY-MM-DD_HH-MM.sql.gz`                                      |
| `make restore BACKUP=path`        | Restore DB from a dump file                                                         |
| `make ngrok`                      | Start ngrok tunnel for Postmark webhook testing                                     |

## Local Development

### Starting the stack

```bash
make up       # starts api + worker + postgres + redis, runs migrations
make seed     # populate test data (jobs + candidate)
make logs     # watch all container logs
```

### Testing webhooks locally with ngrok

```bash
make ngrok
# Opens HTTPS tunnel to localhost:3000 and prints the public URL.
# Copy the URL and configure Postmark:
#   Postmark Dashboard → Inbound → Webhook URL:
#   https://postmark:<POSTMARK_WEBHOOK_TOKEN>@<ngrok-id>.ngrok.io/api/webhooks/email
```

The ngrok URL changes on every restart — update Postmark each session.

### Running tests

```bash
make test           # runs jest inside Docker (same as CI)
npm run test        # runs locally (faster, requires Node installed)
npm run test:e2e    # E2E smoke tests (boots full NestJS app, hits /api/health)
```

### Resetting to a clean state

```bash
make reset   # wipes postgres_data and redis_data volumes, then make up
make seed    # re-seed after reset
```

## API Documentation

Full REST API contract: see `PROTOCOL.md` for all endpoints, request/response shapes, and status codes.

Key endpoints:

- `GET /api/health` — liveness probe (200 = healthy, 503 = degraded with DB/Redis check details)
- `GET /api/jobs` — list all jobs
- `GET /api/candidates` — list candidates (supports `?q=`, `?filter=`, `?job_id=`)
- `GET /api/candidates/:id` — single candidate
- `POST /api/jobs` — create a job
- `PUT /api/jobs/:id` — update a job
- `DELETE /api/jobs/:id` — soft-delete a job
- `POST /api/webhooks/email` — Postmark inbound webhook (requires HTTP Basic Auth)

## Architecture

```
Postmark → POST /api/webhooks/email → BullMQ queue → Worker
                                                        ↓
                               SpamFilter → AttachmentExtractor → R2 upload
                                                        ↓
                               ExtractionAgent (gpt-4o-mini via OpenRouter) → DedupService (pg_trgm)
                                                        ↓
                               ScoringAgent (gpt-4o-mini via OpenRouter) → PostgreSQL
```

## Pipeline Flowchart

```
Postmark
   │  POST /api/webhooks/email (HTTP Basic Auth)
   ▼
Idempotency Check (emailIntakeLog)
   │  duplicate? → 200 OK (skip)
   ▼
BullMQ Redis Queue ("ingest-email")
   │  return 200 immediately
   ▼
Worker: SpamFilter
   │  spam or no CV? → reject job
   ▼
Worker: AttachmentExtractor
   │  PDF/DOCX → plain text
   ▼
Worker: R2 Upload
   │  store original CV file
   ▼
Worker: ExtractionAgent (gpt-4o-mini via OpenRouter)
   │  plain text → structured CandidateExtract JSON
   ▼
Worker: DedupService (pg_trgm phone-exact match)
   │  duplicate? → flag for HR review, skip insert
   ▼
Worker: ScoringAgent (gpt-4o-mini via OpenRouter)
   │  score candidate against all open jobs
   ▼
PostgreSQL
   candidates + candidate_job_scores tables
```

- **API service** (port 3000): Receives Postmark inbound webhooks, validates Basic Auth, enqueues jobs in BullMQ
- **Worker service**: Processes jobs — extracts text from CV attachments, runs AI extraction, deduplicates via pg_trgm, scores against open jobs, stores in PostgreSQL
- **PostgreSQL 16**: All persistent data; pg_trgm extension for fuzzy candidate deduplication
- **Redis 7**: BullMQ job queue between API and Worker
- **Cloudflare R2**: Stores original CV files (S3-compatible, 10 GB free tier)

## Deployment

### Prerequisites

- Hetzner VPS (CX21 recommended: 2 vCPU, 4 GB RAM) or any Linux server with Docker installed
- Domain name with DNS A record pointing to server IP
- SSH access configured for the server

### First-time server setup

```bash
# On the server:
git clone <repo> ~/triolla
cp ~/triolla/.env.example ~/triolla/.env
# Edit ~/triolla/.env with production secrets
```

### Deploy

```bash
PROD_HOST=ubuntu@your.server.ip ./scripts/deploy.sh main
```

The deploy script SSHes to the server, pulls the specified branch, and runs `docker compose up -d --build`. It does NOT run migrations automatically.

### CI/CD (GitHub Actions)

Push to `main` triggers the GitHub Actions workflow (`.github/workflows/ci.yml`) — runs install → build → test → Docker build.

The pipeline does NOT auto-deploy — deploy is always a manual action via `scripts/deploy.sh`.

```
on: push to main → Install → Build → Test → Docker Build
```

## Troubleshooting

| Problem                                     | Solution                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `make up` hangs waiting for DB              | Run `make logs` in another terminal to see postgres startup errors. Usually a missing `POSTGRES_PASSWORD` in `.env`. |
| Migrations fail: "Database does not exist"  | Run `make reset` to wipe volumes and start fresh.                                                                    |
| `TENANT_ID not found` at startup            | Run `make seed` to create the default tenant and get its UUID. Update `.env` with the UUID.                          |
| Postmark webhook returns 401                | Check `POSTMARK_WEBHOOK_TOKEN` in `.env` matches the token configured in Postmark Dashboard → Inbound → Settings.    |
| CV processing fails silently                | Check worker logs: `make logs`. Look for `Job failed` log lines with an `error` field.                               |
| Port 3000 already in use                    | Stop other processes: `lsof -i :3000`. Or set `PORT=3001` in `.env`.                                                 |
| Docker build fails: `prisma generate` error | Run `make reset` — stale node_modules volume sometimes has mismatched binaries.                                      |
| `make test` runs forever                    | Tests are running inside Docker. First run downloads the image. Subsequent runs are faster.                          |
| `make seed` fails: duplicate key            | Run `make reset` first to clear the database, then `make up` and `make seed`.                                        |
