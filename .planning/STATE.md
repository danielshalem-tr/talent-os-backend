# State: Triolla Talent OS — Backend (Phase 1)

**Initialized:** 2026-03-22 at 00:00 UTC
**Model:** Claude Haiku 4.5
**Budget:** 200,000 tokens

## Project Reference

**Core Value:** Inbound CVs are automatically processed, de-duplicated, and scored against open jobs without any manual recruiter effort — end-to-end from email receipt to scored candidate record.

**Current Focus:** Build the automated email intake pipeline (Phase 1 only, no UI, no recruiter auth).

**Tech Stack (Locked):** TypeScript, NestJS 11, BullMQ + Redis, Prisma 6, PostgreSQL 16, Vercel AI SDK, Claude Haiku + Sonnet, Cloudflare R2, Postmark Inbound webhooks.

## Current Position

**Milestone:** Phase 1 (Foundation)
**Active Phase:** None (planning complete, ready for `/gsd:plan-phase 1`)
**Active Plan:** None
**Status:** Roadmap approved, awaiting phase planning

**Progress Bar:**

```
Phases completed: 0/7
Phase 1 plans: 0/4 complete
Current phase completion: 0%
Overall project completion: 0%
```

## Accumulated Context

### Decisions Locked (Phase 1 scope)

1. **Database Schema First**: All 7 tables with tenant_id, indexes, constraints created in Prisma migration before webhook endpoint
2. **Separate API + Worker**: NestJS HTTP only, separate BullMQ worker process — never block webhook receipt
3. **Environment Validation at Startup**: @nestjs/config + Zod — fail fast on missing vars, don't deploy broken config
4. **No In-Memory Dedup**: pg_trgm extension, not vector DB or Elasticsearch — scales naturally, zero infra
5. **Append-Only Scores**: candidate_job_scores never updated, always appended — full history preserved
6. **Fuzzy Match → Human Review**: Never auto-upsert on fuzzy match — dual-name confusion is data corruption, flag for human

### Research Completed

- Full architecture spec approved 2026-03-19: `spec/backend-architecture-proposal.md`
- Postmark inbound webhook auth method confirmed
- pg_trgm performance validated at 500 CVs/month scale
- Cost model: ~€5/month Hetzner + ~$6–16/month Anthropic

### Open Questions (Phase 2+)

- Recruiter auth solution (JWT vs Clerk vs other)
- Outbound email provider for candidate outreach
- Voice screening approach (Twilio vs Elevenlabs vs other)
- Monitoring tooling (Sentry + BullMQ dashboard recommended but not blocking)

### Blockers

None — ready to proceed to `/gsd:plan-phase 1`.

### Todos

- [ ] `/gsd:plan-phase 1` — Decompose Phase 1: Foundation into executable plans
- [ ] Implement database migrations
- [ ] Implement NestJS bootstrap with rawBody: true
- [ ] Implement Worker process with BullMQ
- [ ] Local Docker Compose verification
- [ ] Deploy to Hetzner VPS

## Session Continuity

**Last Session:** Initial roadmap creation (2026-03-22)

**What Happened:**
1. PROJECT.md and REQUIREMENTS.md read
2. 40 v1 requirements analyzed and clustered
3. 7 natural phases identified (Foundation → Webhook → Spam Filter → Extraction → File Storage → Dedup → Scoring)
4. Success criteria derived for each phase (2-5 observable behaviors per phase)
5. 100% requirement coverage validated (40/40 mapped)
6. ROADMAP.md, STATE.md created; REQUIREMENTS.md traceability updated

**Next Step:**
User reviews roadmap for approval or provides feedback. After approval, `/gsd:plan-phase 1` decomposes Phase 1 into executable plans.

---

*State initialized: 2026-03-22 at 00:00 UTC*
