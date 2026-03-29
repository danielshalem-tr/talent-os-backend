---
quick_task: 260329-lpo
title: Simplify prisma/seed.ts with 3 jobs, 1 candidate, 1 application
description: Reduce seed data to 4 tables (Tenant, Job, Candidate, Application); remove --tenant-only option
estimated_effort: 15-20 min
depends_on: []
files_modified:
  - prisma/seed.ts
  - package.json
autonomous: true
---

## Objective

Simplify the seeding script to provide a minimal, focused test dataset that demonstrates the core 4-table schema without historical complexity or staging data. This makes the seed faster, the database lighter for testing, and the code easier to understand.

**What:** Reduce seed from 5 jobs + 12 candidates + hiring stages + scores to 3 jobs + 1 candidate + 1 application

**Why:** Faster local development, simpler mental model, easier to debug seed issues, reduces clutter for Phase 2 recruiter UI planning

**Output:** Simplified seed.ts + updated package.json scripts

## Context

Current seed.ts (700 lines):
- 5 jobs (open, draft, closed statuses)
- 12 candidates across multiple stages
- 40 hiring stage records
- 10 AI scores
- 1 duplicate flag
- Support for `--tenant-only` flag

New seed.ts:
- Tenant (Triolla, same ID)
- 3 jobs: Senior Software Engineer, Product Manager, Data Scientist (all open status, fully populated)
- 1 candidate: Example engineer matching first job
- 1 application: Linking candidate to first job
- No hiring stages, scores, flags, email logs, or screening questions

## Tasks

<task type="auto">
  <name>Task 1: Rewrite prisma/seed.ts with minimal data</name>
  <files>prisma/seed.ts</files>
  <action>
    Replace entire seed.ts with simplified version:

    1. Keep TENANT_ID and job UUIDs (deterministic for idempotency)
    2. Remove: stage IDs, candidate IDs (except 1), application IDs (except 1), score IDs, duplicate flag ID
    3. Keep only these constants:
       - TENANT_ID (Triolla)
       - JOB_SE, JOB_PM, JOB_DS (3 jobs, no more)
    4. Remove: buildStages() function (no job stages needed)
    5. Main function: Remove isTenantOnly logic and --tenant-only check
    6. Seed sequence:
       - Tenant (Triolla)
       - 3 Jobs: Populate ALL schema fields from schema.prisma (title, department, location, jobType, status, description, requirements, salaryRange, hiringManager, roleSummary, responsibilities, whatWeOffer, mustHaveSkills, niceToHaveSkills, expYearsMin, expYearsMax, preferredOrgTypes)
       - 1 Candidate: Yael Cohen (apply to Senior Software Engineer, basic fields: fullName, email, phone, currentRole, location, yearsExperience, skills, source, aiSummary)
       - 1 Application: Link Yael to Senior Software Engineer job
    7. Remove sections: hiring stages, all 12 candidates (keep only 1), all applications (keep only 1), AI scores, duplicate flags
    8. Logging: Update console.log messages to reflect simplified data (e.g., "✓ Jobs (3 open)" instead of "✓ Jobs (5 — 3 open, 1 draft, 1 closed)")
    9. Summary at end: Simplify to just mention "3 jobs + 1 candidate + 1 application"

    Keep deterministic UUIDs for reproducible seed across environments.
    Do NOT simplify field values — use realistic job descriptions and candidate data. This is reference data for Phase 2 UI design.
  </action>
  <verify>
    - prisma/seed.ts exists and is valid TypeScript
    - No compile errors: npx ts-node prisma/seed.ts (will fail at DB, that's OK)
    - File contains: Tenant, 3 jobs with populated fields, 1 candidate, 1 application
    - File does NOT contain: --tenant-only, buildStages, hiring stages, scores, duplicate flags, 12 candidates
  </verify>
  <done>
    - seed.ts is 150-200 lines (vs. 700)
    - Tenant, 3 full-featured jobs, 1 candidate, 1 application are defined
    - Console output is updated for new data shape
  </done>
</task>

<task type="auto">
  <name>Task 2: Remove --tenant-only from package.json scripts</name>
  <files>package.json</files>
  <action>
    Edit package.json scripts section:

    Find and update:
    - Line 15: db:setup:local script currently calls `npx ts-node prisma/seed.ts --tenant-only`
    - Change to: `npx ts-node prisma/seed.ts` (remove --tenant-only flag)

    Context: The --tenant-only flag was used to seed only the tenant record for partial database setups. With simplified seed, we always seed the full dataset (tenant + 3 jobs + 1 candidate + 1 app), so the flag is no longer needed.
  </action>
  <verify>
    - package.json is valid JSON
    - Line 15 (db:setup:local) no longer has --tenant-only
    - Other scripts unchanged
  </verify>
  <done>
    - db:setup:local script updated
    - --tenant-only flag removed from codebase
  </done>
</task>

## Verification

After both tasks complete:

```bash
# 1. Check file syntax
npx ts-node -e "import('./prisma/seed.ts')" 2>&1 | head -20

# 2. Check package.json is valid
cat package.json | jq '.scripts.["db:setup:local"]'

# 3. Verify --tenant-only is gone
grep -r "\-\-tenant-only" . --include="*.ts" --include="*.json" || echo "✓ --tenant-only removed"
```

## Success Criteria

- seed.ts compiles without errors
- seed.ts is 150-300 lines (down from 700)
- Only 4 tables seeded: Tenant, Job (3x), Candidate (1x), Application (1x)
- All 3 jobs have ALL schema fields populated (not just title + description)
- 1 candidate has realistic but minimal data (name, email, phone, skills, current role)
- 1 application links candidate to first job
- `--tenant-only` removed from package.json scripts
- `--tenant-only` does not appear in seed.ts at all
- Console output reflects new data shape

## Output

After completion, commit changes:
```
chore(db): simplify seed.ts to 4 tables (tenant, 3 jobs, 1 candidate, 1 app)
```
