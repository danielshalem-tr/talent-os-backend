---
quick_id: 260414-cuk
phase: quick
plan: 260414-cuk
subsystem: planning / seed / env
tags: [pre-prod, seed-audit, env-vars, phase-20, tenant-isolation]
key_files:
  created: []
  modified:
    - prisma/seed.ts
    - .planning/phases/20-tenant-isolation/20-CONTEXT.md
    - .planning/phases/20-tenant-isolation/20-01-PLAN.md
    - .planning/phases/20-tenant-isolation/20-02-PLAN.md
    - .planning/phases/20-tenant-isolation/20-03-PLAN.md
decisions:
  - "seed.ts verified clean — all Prisma field names match schema.prisma exactly, no fixes needed"
  - "JWT_SECRET is the only new REQUIRED env var for Phase 20 deployment"
  - "FRONTEND_URL must be set to production URL (has default but default is localhost)"
  - "TENANT_ID remains useful on both containers despite being optional in env.ts after Phase 20 D-08"
  - "Email uses nodemailer+SMTP vars pointing to Resend SMTP relay — SMTP_* vars are the correct set"
metrics:
  duration: "10 minutes"
  completed_date: "2026-04-14"
  tasks_completed: 3
  files_modified: 5
---

# Quick Task 260414-cuk: Pre-Production Checklist for Phase 20 — Summary

**One-liner:** Committed all 5 uncommitted Phase 20 files, verified seed.ts field names match schema.prisma with no drift, and produced Coolify env var delta with JWT_SECRET as the only new required var.

## Tasks Completed

### Task 1: Commit all unsaved changes

Two atomic commits created:

| Commit | Hash | Message |
|--------|------|---------|
| Planning artifacts | `a5f16a8` | `docs(20): add phase 20 tenant-isolation context and plans` |
| Seed file | `01a3016` | `fix(seed): update seed.ts for phase 20 tenant isolation` |

Both commits verified with `git log --oneline`. Working tree clean for all 5 target files.

### Task 2: Seed.ts field audit

Field-by-field audit of every Prisma create/upsert call against schema.prisma:

| Model | Fields Used in Seed | Result |
|-------|--------------------|----|
| `Organization` | `id`, `name`, `shortId` | PASS — all match schema |
| `Job` | `id`, `tenantId`, `title`, `shortId`, `department`, `location`, `jobType`, `status`, `description`, `requirements`, `salaryRange`, `hiringManager`, `roleSummary`, `responsibilities`, `whatWeOffer`, `mustHaveSkills`, `niceToHaveSkills`, `expYearsMin`, `expYearsMax`, `preferredOrgTypes` | PASS — all match schema |
| `JobStage` (nested) | `id`, `tenantId`, `name`, `order`, `isCustom`, `color`, `isEnabled` | PASS — all match schema |
| `Candidate` | `id`, `tenantId`, `jobId`, `hiringStageId`, `fullName`, `email`, `phone`, `currentRole`, `location`, `yearsExperience`, `skills`, `source`, `aiSummary` | PASS — all match schema |
| `Application` | `id`, `tenantId`, `candidateId`, `jobId`, `jobStageId`, `stage`, `appliedAt` | PASS — `jobStageId` correct (not `stageId`) |
| `CandidateJobScore` | `id`, `tenantId`, `applicationId`, `score`, `reasoning`, `strengths`, `gaps`, `modelUsed` | PASS — all match schema |
| `CandidateStageSummary` | `id`, `tenantId`, `candidateId`, `jobStageId`, `summary`; where: `idx_cand_stage_summary: { candidateId, jobStageId }` | PASS — unique name and fields match schema |

**Result: No changes needed. Zero field drift.**

### Task 3: Coolify env var delta

#### Verification — no undocumented env vars

```bash
grep -rn "configService\.get\|process\.env\." src/ --include="*.ts" \
  | grep -v "spec|test" \
  | grep -v "DATABASE_URL|REDIS_URL|OPENROUTER_API_KEY|POSTMARK_WEBHOOK_TOKEN|TENANT_ID|R2_|SMTP_|JWT_SECRET|GOOGLE_CLIENT_ID|FRONTEND_URL|NODE_ENV|PORT|LOG_LEVEL|TZ"
```

**Output: empty — no undocumented references.**

---

## Coolify Env Var Delta for Phase 20 Deployment

### Baseline vars — assumed already set in Coolify (pre-Phase 19)

| Var | Status |
|-----|--------|
| `DATABASE_URL` | Set |
| `REDIS_URL` | Set |
| `OPENROUTER_API_KEY` | Set |
| `POSTMARK_WEBHOOK_TOKEN` | Set |
| `TENANT_ID` | Set (see note below) |
| `R2_ACCOUNT_ID` | Set |
| `R2_ACCESS_KEY_ID` | Set |
| `R2_SECRET_ACCESS_KEY` | Set |
| `R2_BUCKET_NAME` | Set |

### New vars — must be added to Coolify before deploying Phase 20

| Var | Required? | Action | Notes |
|-----|-----------|--------|-------|
| `JWT_SECRET` | **REQUIRED** | **ADD NOW** | Min 32 chars. Generate: `openssl rand -base64 48`. Without this, API server fails to start. |
| `FRONTEND_URL` | **Strongly Recommended** | **ADD NOW** | Set to `https://talentos.triolla.io`. Default is `http://localhost:5173` — will produce broken magic-link and invitation URLs in production. |
| `GOOGLE_CLIENT_ID` | Optional | Add if Google OAuth is active | Leave unset to disable Google login. |
| `SMTP_HOST` | Optional | Add to enable email delivery | Use `smtp.resend.com` with Resend. Without it, emails are logged (dev fallback) but not sent. |
| `SMTP_PORT` | Optional | Add with `SMTP_HOST` | `587` for Resend SMTP. |
| `SMTP_USER` | Optional | Add with `SMTP_HOST` | `resend` (literal string) for Resend SMTP. |
| `SMTP_PASS` | Optional | Add with `SMTP_HOST` | Resend API key used as SMTP password. |
| `SMTP_FROM` | Optional | Add with `SMTP_HOST` | e.g. `no-reply@triolla.io`. Defaults to `noreply@talentos.triolla.io`. |

### TENANT_ID behavior after Phase 20

Phase 20 decision D-08 made `TENANT_ID` optional in env.ts — the API server no longer requires it at startup.

However:
- The **worker container** (`src/worker.ts`, `IngestionProcessor`) still uses `TENANT_ID` for all Postmark webhook flows — it remains required at runtime for the worker.
- **Recommendation:** Keep `TENANT_ID` set on **both** containers in Coolify. Removing it from the API container is safe but gains nothing. Keep it for operational consistency.

### Copy-paste commands for Coolify setup

```bash
# Generate JWT_SECRET (run locally, paste value into Coolify)
openssl rand -base64 48
```

---

## Deviations from Plan

None — plan executed exactly as written. seed.ts had zero field drift, so no changes were required. The commit message for `fix(seed)` accurately notes that the file was verified, not corrected.

## Self-Check: PASSED

- Commit `a5f16a8` present: `git log --oneline | grep a5f16a8` — FOUND
- Commit `01a3016` present: `git log --oneline | grep 01a3016` — FOUND
- All 5 target files committed, working tree clean for those paths
- Env var grep returned empty — no undocumented references
