# Triolla Talent OS — Backend

Automated email-intake pipeline for Triolla's recruiting platform: CVs arrive by email via
**Mailgun** inbound webhooks → AI extracts candidate data → dedup → scored against open jobs →
stored in PostgreSQL for the recruiter UI. The intake pipeline is fully reactive (no human
trigger), but the platform now also has organizations, users, session auth (Google OAuth +
magic link), invitations, team management, and role-based access (admin / recruiter / viewer).

## Stack (locked, not negotiable)

Packages and versions are in `package.json`. These are *decisions*, not defaults — don't swap them:

- **AI:** OpenRouter (`@openrouter/sdk`) for extraction + scoring
- **Storage:** Cloudflare R2 for original CV files — no binary blobs in the DB
- **Email:** Mailgun inbound webhook → `POST /webhooks/email`
- **Dedup:** pg_trgm in PostgreSQL only — no vector DB, no in-memory fuzzy matching

## Architecture

Two Docker containers, one codebase, two entry points:

- **api** (`src/main.ts`): HTTP — webhooks, auth/team, and the resource modules under `src/`
- **worker** (`src/worker.ts`): BullMQ consumer — ingestion pipeline (extract → dedup → score → store)

## Conventions

- `text` + CHECK constraints over PostgreSQL ENUMs (ENUMs need a migration to add values)
- No binary blobs in DB; `updated_at` via Prisma `@updatedAt`
- `tenant_id` on every table from day 1 (multi-tenancy baked in to avoid a schema rewrite later)

## Commands

`package.json` scripts cover the routine work. The two with a non-obvious precondition:

```bash
npm run db:studio    # requires `npm run docker:up` to be running first
npm run ngrok        # expose the webhook endpoint so real inbound mail can reach it
```

## Environment Variables

`.env.example` is the authoritative list. It carries every variable plus the constraints that
matter — minimum lengths, which ones make the app refuse to start, and which are safe to leave
unset. Read it rather than trusting a copy here.
