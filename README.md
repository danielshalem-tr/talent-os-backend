# Triolla Talent OS — Backend

Automated email intake pipeline: receive CVs by email, extract candidate data with AI, deduplicate, score against open jobs.

## Prerequisites

Before you start, ensure you have the following installed:

- **Docker Desktop** — for running services with `docker compose`
- **Node.js 22+** and **npm** — for running scripts and the Prisma CLI locally
- **ngrok** — for exposing localhost to Postmark inbound webhooks
  - macOS: `brew install ngrok`
  - Other platforms: https://ngrok.com/download
- **A Postmark account** with an inbound webhook server configured (free tier works)

## Environment Setup

```bash
cp .env.example .env
```

Then edit `.env` and fill in each variable:

| Variable                 | Where to get it                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | Anthropic Console -> API Keys                                                                                     |
| `POSTMARK_WEBHOOK_TOKEN` | Choose any secret string; configure the same value in Postmark -> Settings -> Inbound -> HTTP Basic Auth password |
| `R2_ACCOUNT_ID`          | Cloudflare dashboard -> R2 -> Manage R2 API Tokens                                                                |
| `R2_ACCESS_KEY_ID`       | Cloudflare R2 API token                                                                                           |
| `R2_SECRET_ACCESS_KEY`   | Cloudflare R2 API token                                                                                           |
| `R2_BUCKET_NAME`         | Your R2 bucket name (e.g. `triolla-cvs`)                                                                          |
| `POSTGRES_PASSWORD`      | Set to any local password (e.g. `changeme`)                                                                       |
| `TENANT_ID`              | Leave as `00000000-0000-0000-0000-000000000001` (hardcoded dev tenant)                                            |
| `DATABASE_URL`           | Leave as-is — matches `docker-compose.dev.yml`                                                                    |
| `REDIS_URL`              | Leave as-is — matches `docker-compose.dev.yml`                                                                    |

## First Run

**Step 1 — Install dependencies:**

```bash
npm install
```

**Step 2 — Start all services:**

```bash
npm run docker:dev
```

Wait until you see `NestJS application listening` in the logs (usually 15-20 seconds).

**Step 3 — Bootstrap the database** (new terminal, first run only):

```bash
npm run db:setup
```

This runs Prisma migrations and seeds 1 tenant + 1 "Software Engineer" job.

**Step 4 — Verify the API is healthy:**

```bash
node local-test/run.js --health
# Expected output: Health OK
```

## Testing the Full Flow

**Step 1 — Add at least one CV file** (PDF, DOC, or DOCX) to `local-test/files/`.

**Step 2 — Start an ngrok tunnel** so Postmark can reach localhost:

```bash
npm run ngrok
```

Copy the printed URL, e.g.: `https://abc123.ngrok-free.app/webhooks/email`

**Step 3 — Configure Postmark:**

- Go to Postmark -> Settings -> Inbound
- Set the Webhook URL to the ngrok URL printed above
- Set HTTP Basic Auth: username = `postmark`, password = value of `POSTMARK_WEBHOOK_TOKEN` from `.env`

**Step 4 — Send a test webhook locally** (bypasses Postmark, hits localhost directly):

```bash
node local-test/run.js
# Or send a specific file:
node local-test/run.js my-cv.pdf
```

**Step 5 — Watch the worker process the job:**

```bash
npm run docker:logs:worker
```

**Step 6 — Inspect results in Prisma Studio:**

```bash
npm run db:studio
# Open http://localhost:5555
# Check: email_intake_log (status: success), candidates, applications, candidate_job_scores
```

## Useful Commands

| Command                           | What it does                           |
| --------------------------------- | -------------------------------------- |
| `npm run docker:dev`              | Start all services, stream logs        |
| `npm run docker:down`             | Stop and remove containers             |
| `npm run docker:logs`             | Tail all service logs                  |
| `npm run docker:logs:api`         | Tail API logs only                     |
| `npm run docker:logs:worker`      | Tail worker logs only                  |
| `npm run db:setup`                | Run migrations + seed (first run)      |
| `npm run db:studio`               | Open Prisma Studio at localhost:5555   |
| `npm run ngrok`                   | Start ngrok tunnel, print Postmark URL |
| `npm test`                        | Run unit tests                         |
| `node local-test/run.js`          | Send all CVs in local-test/files/      |
| `node local-test/run.js --health` | Check API health                       |

## Architecture

- **API service** (port 3000): Receives Postmark inbound webhooks, validates auth via HTTP Basic Auth, enqueues jobs in BullMQ
- **Worker service**: Processes jobs — extracts text from CV attachments, runs AI extraction (Claude Haiku), deduplicates candidates via pg_trgm, scores against open jobs (Claude Sonnet), stores results in PostgreSQL
- **PostgreSQL 16**: All persistent data; pg_trgm extension for fuzzy candidate deduplication
- **Redis 7**: BullMQ job queue between API and Worker
- **Cloudflare R2**: Stores original CV files (S3-compatible, 10 GB free tier)
