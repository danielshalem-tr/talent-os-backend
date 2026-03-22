<!-- GSD:project-start source:PROJECT.md -->
## Project

**Triolla Talent OS — Backend**

An automated email intake pipeline for Triolla's recruiting platform. It receives CVs by email via Postmark webhooks, extracts candidate data using AI, detects duplicates, scores candidates against open positions, and stores everything in PostgreSQL — ready for the recruiter UI to consume in Phase 2. Phase 1 is purely reactive: no human-initiated writes, no auth, no UI.

**Core Value:** Inbound CVs are automatically processed, de-duplicated, and scored against open jobs without any manual recruiter effort — the pipeline runs end-to-end from email receipt to scored candidate record.

### Constraints

- **Tech Stack:** TypeScript only, NestJS 11, BullMQ + Redis, Prisma 6, PostgreSQL 16, Vercel AI SDK — locked, not negotiable
- **AI Provider:** Anthropic Claude via `@ai-sdk/anthropic` — Haiku for extraction, Sonnet for scoring. No local models in Phase 1.
- **Storage:** Cloudflare R2 for original CV files (S3-compatible, 10GB free tier)
- **Email:** Postmark Inbound webhooks — no Gmail API polling in Phase 1
- **Dedup:** pg_trgm in PostgreSQL only — no in-memory fuzzy matching, no vector DB
- **DB conventions:** `text` + CHECK constraints over PostgreSQL ENUMs (ENUMs require migration to add values); no binary blobs in DB; `updated_at` via Prisma `@updatedAt`
- **Multi-tenancy:** `tenant_id` on every table from day 1 — prevents schema rewrite later
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
