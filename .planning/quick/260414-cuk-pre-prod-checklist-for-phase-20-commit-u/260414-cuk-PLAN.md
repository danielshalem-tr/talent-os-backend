---
phase: quick
plan: 260414-cuk
type: execute
wave: 1
depends_on: []
files_modified:
  - prisma/seed.ts
  - .planning/phases/20-tenant-isolation/20-CONTEXT.md
  - .planning/phases/20-tenant-isolation/20-01-PLAN.md
  - .planning/phases/20-tenant-isolation/20-02-PLAN.md
  - .planning/phases/20-tenant-isolation/20-03-PLAN.md
autonomous: true
requirements: []

must_haves:
  truths:
    - All phase 20 planning files are committed to git
    - Modified prisma/seed.ts is committed to git
    - seed.ts fields match schema.prisma exactly with no stale columns
    - Coolify env var delta is documented clearly (new vars vs pre-existing)
  artifacts:
    - path: "prisma/seed.ts"
      provides: "Working seed with correct field names per schema"
    - path: ".planning/phases/20-tenant-isolation/20-CONTEXT.md"
      provides: "Phase 20 context committed"
  key_links:
    - from: "prisma/seed.ts"
      to: "prisma/schema.prisma"
      via: "Field names must match Prisma model fields exactly"
      pattern: "tenantId"
---

<objective>
Pre-production checklist for Phase 20 (tenant isolation): commit all unsaved changes,
verify seed.ts correctness against schema.prisma, and produce a clear Coolify env var
delta for deployment.

Purpose: Clear the decks before shipping Phase 20 to production. No uncommitted work,
no seed drift, no missing env var surprises.
Output: Clean git state, verified seed, documented env var checklist.
</objective>

<execution_context>
@/Users/danielshalem/triolla/talento/talent-os-backend/.claude/get-shit-done/workflows/execute-plan.md
@/Users/danielshalem/triolla/talento/talent-os-backend/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/phases/20-tenant-isolation/20-CONTEXT.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Commit all unsaved changes with atomic messages</name>
  <files>
    prisma/seed.ts
    .planning/phases/20-tenant-isolation/20-CONTEXT.md
    .planning/phases/20-tenant-isolation/20-01-PLAN.md
    .planning/phases/20-tenant-isolation/20-02-PLAN.md
    .planning/phases/20-tenant-isolation/20-03-PLAN.md
  </files>
  <action>
    Create two separate commits:

    **Commit 1 — planning artifacts (untracked files):**
    Stage only the four planning files and commit with message:
    `docs(20): add phase 20 tenant-isolation context and plans`

    Files to stage:
    - `.planning/phases/20-tenant-isolation/20-CONTEXT.md`
    - `.planning/phases/20-tenant-isolation/20-01-PLAN.md`
    - `.planning/phases/20-tenant-isolation/20-02-PLAN.md`
    - `.planning/phases/20-tenant-isolation/20-03-PLAN.md`

    **Commit 2 — seed.ts (modified file):**
    Stage `prisma/seed.ts` and commit with message:
    `fix(seed): update seed.ts for phase 20 tenant isolation`

    (If the seed needs corrections per Task 2, perform those corrections before this commit
    and include a description of what changed.)

    Run `git status` after both commits to confirm clean working tree on these files.
  </action>
  <verify>
    `git status` shows no untracked or modified state for the five files listed above.
    `git log --oneline -3` shows the two new commits at HEAD.
  </verify>
  <done>All five files committed. Working tree clean for these paths.</done>
</task>

<task type="auto">
  <name>Task 2: Audit seed.ts field names vs schema.prisma and fix any drift</name>
  <files>prisma/seed.ts</files>
  <action>
    Perform a field-by-field audit of every Prisma create/upsert call in seed.ts against
    the corresponding model in schema.prisma. Fix any mismatches in seed.ts.

    **Known state from analysis (verify and fix if wrong):**

    Organization (seed upsert):
    - `id`, `name`, `shortId` — all present in schema. PASS.
    - `logoUrl`, `isActive` etc. are optional — not seeding them is fine.

    Job (seed create):
    - All fields present: `id`, `tenantId`, `title`, `shortId`, `department`, `location`,
      `jobType`, `status`, `description`, `requirements`, `salaryRange`, `hiringManager`,
      `roleSummary`, `responsibilities`, `whatWeOffer`, `mustHaveSkills`, `niceToHaveSkills`,
      `expYearsMin`, `expYearsMax`, `preferredOrgTypes`. PASS.
    - `hiringStages.create` nested: `id`, `tenantId`, `name`, `order`, `isCustom`, `color`,
      `isEnabled`. Schema has `interviewer` as optional — not seeding is fine. PASS.

    Candidate (seed upsert):
    - Fields: `id`, `tenantId`, `jobId`, `hiringStageId`, `fullName`, `email`, `phone`,
      `currentRole`, `location`, `yearsExperience`, `skills`, `source`, `aiSummary`. All
      exist in schema. PASS.
    - Schema also has: `cvText`, `cvFileUrl`, `sourceAgency`, `sourceEmail`, `aiScore`,
      `metadata`, `status`, `rejectionReason`, `rejectionNote` — all optional, not needed in seed.

    Application (seed upsert):
    - Fields: `id`, `tenantId`, `candidateId`, `jobId`, `jobStageId`, `stage`, `appliedAt`.
      All exist in schema. PASS.
    - Note: schema field is `jobStageId` (maps to `job_stage_id`) — confirm seed uses `jobStageId`
      not `stageId` or any other alias. Current seed uses `jobStageId: app.stageId` — PASS.

    CandidateJobScore (seed upsert):
    - Fields: `id`, `tenantId`, `applicationId`, `score`, `reasoning`, `strengths`, `gaps`,
      `modelUsed`. All exist in schema. PASS.
    - `matchConfidence` is optional — not seeding is fine.

    CandidateStageSummary (seed upsert):
    - Fields: `id`, `tenantId`, `candidateId`, `jobStageId`, `summary`. All exist in schema. PASS.
    - `where` clause uses `idx_cand_stage_summary: { candidateId, jobStageId }` which matches
      `@@unique([candidateId, jobStageId], name: "idx_cand_stage_summary")` in schema. PASS.

    **Models NOT seeded (correct — no seed data needed):**
    - `User` — created via auth flow (Phase 19)
    - `Invitation` — operational
    - `DuplicateFlag` — operational (dedup pipeline)
    - `EmailIntakeLog` — operational (email intake)
    - `ScreeningQuestion` — optional per job

    **Action:** If all checks pass, no file change needed. If any field mismatch is found,
    correct the field name in seed.ts to match the Prisma model field (camelCase, as Prisma
    maps to snake_case DB columns automatically). Do NOT change schema.prisma.

    After any corrections, run:
    ```bash
    npx ts-node --project tsconfig.json prisma/seed.ts
    ```
    or use `npx prisma db seed` if configured in package.json, to verify the seed executes
    without runtime errors.
  </action>
  <verify>
    If seed.ts was changed: `git diff prisma/seed.ts` shows only field name fixes.
    Seed script executes without TypeScript or Prisma runtime errors.
    If seed.ts was unchanged: confirm in output that all fields were verified clean.
  </verify>
  <done>
    Every Prisma create/upsert in seed.ts uses field names that exactly match the
    corresponding schema.prisma model fields. No stale or renamed fields remain.
  </done>
</task>

<task type="auto">
  <name>Task 3: Document Coolify env var delta for Phase 20 deployment</name>
  <files>None — output is printed to stdout only, no file created</files>
  <action>
    Inspect `src/config/env.ts` and identify every env var it validates. Cross-reference
    against the CLAUDE.md "Required Environment Variables" list (which reflects the pre-Phase-19
    baseline). Produce a clear delta report.

    **Baseline vars (in CLAUDE.md — assumed already set in Coolify):**
    - `DATABASE_URL`
    - `REDIS_URL`
    - `OPENROUTER_API_KEY`
    - `POSTMARK_WEBHOOK_TOKEN`
    - `TENANT_ID` (now optional per Phase 20 D-08 — can be removed from API container
      but keep for worker container which still uses it in IngestionProcessor)
    - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`

    **New vars added in Phase 19 (auth) — must be added to Coolify):**

    | Var | Required? | Notes |
    |-----|-----------|-------|
    | `JWT_SECRET` | REQUIRED | Min 32 chars. Generate with: `openssl rand -base64 48`. Without this, API server crashes at startup. |
    | `FRONTEND_URL` | Recommended | Default is `http://localhost:5173` — must be set to `https://talentos.triolla.io` in prod. |
    | `GOOGLE_CLIENT_ID` | Optional | Only needed if Google OAuth is active. Leave unset to disable Google login. |
    | `SMTP_HOST` | Optional | SMTP server for magic link emails. Use `smtp.resend.com` with Resend. |
    | `SMTP_PORT` | Optional | 587 for Resend SMTP. |
    | `SMTP_USER` | Optional | Resend SMTP username: `resend`. |
    | `SMTP_PASS` | Optional | Resend API key used as SMTP password. |
    | `SMTP_FROM` | Optional | From address, e.g. `no-reply@triolla.io`. |

    **TENANT_ID behavior after Phase 20:**
    - Phase 20 made `TENANT_ID` optional in env.ts (D-08).
    - The API server no longer requires it at startup.
    - The worker container (`src/worker.ts`) still uses `TENANT_ID` in `IngestionProcessor`
      for the Postmark webhook flow — keep it set on the worker container in Coolify.
    - Recommendation: Keep `TENANT_ID` set on both containers for safety.

    Print the complete delta report as output, including copy-paste-ready values where
    applicable (e.g., the openssl command for JWT_SECRET generation).
  </action>
  <verify>
    Grep confirms no other `configService.get` or `process.env.` references outside the
    known set:
    ```bash
    grep -r "configService.get\|process\.env\." src/ --include="*.ts" \
      | grep -v "spec\|test" \
      | grep -v "DATABASE_URL\|REDIS_URL\|OPENROUTER_API_KEY\|POSTMARK_WEBHOOK_TOKEN\|TENANT_ID\|R2_\|SMTP_\|JWT_SECRET\|GOOGLE_CLIENT_ID\|FRONTEND_URL\|NODE_ENV\|PORT\|LOG_LEVEL\|TZ"
    ```
    Expected: empty output (no unknown env var references).
  </verify>
  <done>
    Complete env var delta documented. JWT_SECRET identified as the only new REQUIRED var.
    No undocumented env var references remain in source.
  </done>
</task>

</tasks>

<verification>
1. `git status` is clean for all five files.
2. `git log --oneline -5` shows the two new commits.
3. seed.ts field names verified against schema — no drift.
4. Coolify delta printed: JWT_SECRET (required), FRONTEND_URL (recommended), SMTP_*/GOOGLE_CLIENT_ID (optional), TENANT_ID behavior clarified.
</verification>

<success_criteria>
- All five uncommitted files are in git with meaningful commit messages
- Every Prisma model field in seed.ts matches schema.prisma
- Developer has a clear, actionable list of env vars to add/verify in Coolify before deploying Phase 20
</success_criteria>

<output>
After completion, create `.planning/quick/260414-cuk-pre-prod-checklist-for-phase-20-commit-u/260414-cuk-SUMMARY.md`
</output>
