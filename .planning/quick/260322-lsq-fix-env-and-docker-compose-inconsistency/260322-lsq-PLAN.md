---
phase: quick-260322-lsq
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - docker-compose.yml
  - prisma.config.ts
  - prisma/prisma.config.ts
autonomous: true
requirements: []

must_haves:
  truths:
    - "prisma.config.ts lives at project root (Prisma 7 requirement)"
    - "docker-compose api and worker services have explicit DATABASE_URL and REDIS_URL environment vars pointing to docker service names"
    - "Local dev .env uses localhost URLs, not docker service names"
  artifacts:
    - path: "prisma.config.ts"
      provides: "Prisma 7 config at correct root location"
    - path: "docker-compose.yml"
      provides: "Container-runtime env vars for api and worker services"
  key_links:
    - from: "prisma.config.ts"
      to: "prisma/"
      via: "schema path reference"
      pattern: "schema.*prisma"
---

<objective>
Commit the already-made fixes for two bugs introduced by quick task 260322-kkx (Prisma 6→7 upgrade).

Purpose: Both bugs silently break local dev — wrong prisma.config.ts location prevents Prisma 7 from loading its config; wrong REDIS_URL in .env breaks BullMQ when running outside Docker.

Output: A single commit capturing all three changes (docker-compose.yml env blocks, prisma.config.ts moved to root, prisma/prisma.config.ts deleted).
</objective>

<execution_context>
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/workflows/execute-plan.md
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Stage and commit env + docker-compose fixes</name>
  <files>docker-compose.yml, prisma.config.ts, prisma/prisma.config.ts</files>
  <action>
Stage the three tracked file changes and commit them:

1. `docker-compose.yml` — added `environment:` blocks to api and worker services with DATABASE_URL=postgres://...:5432/..., REDIS_URL=redis://redis:6379, NODE_ENV=production so container runtime overrides any local .env values
2. `prisma.config.ts` (NEW at project root) — correct location for Prisma 7 config
3. `prisma/prisma.config.ts` (DELETED) — wrong location, was placed in prisma/ subdir by task 260322-kkx

Note: .env is gitignored and not staged. The REDIS_URL and NODE_ENV fixes there are local-only.

Run:
```
git add docker-compose.yml prisma.config.ts prisma/prisma.config.ts
git commit -m "fix(260322-lsq): move prisma.config.ts to root and add docker env overrides

- prisma/prisma.config.ts removed (Prisma 7 requires config at project root)
- prisma.config.ts added at project root (correct location)
- docker-compose api + worker: explicit DATABASE_URL, REDIS_URL, NODE_ENV
  so container runtime doesn't inherit broken local .env values

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
  </action>
  <verify>
    <automated>git log --oneline -1 && git show --stat HEAD</automated>
  </verify>
  <done>Commit exists with all three file changes; `git status` is clean; `prisma.config.ts` appears at project root in git history; `prisma/prisma.config.ts` shows as deleted.</done>
</task>

</tasks>

<verification>
- `git show --stat HEAD` lists docker-compose.yml (modified), prisma.config.ts (new), prisma/prisma.config.ts (deleted)
- `git status` shows clean working tree
- `ls prisma.config.ts` confirms file exists at project root
- `ls prisma/prisma.config.ts` returns "no such file"
</verification>

<success_criteria>
Single commit on main capturing all three tracked file changes. Local .env fixes are intentionally not committed (gitignored).
</success_criteria>

<output>
After completion, create `.planning/quick/260322-lsq-fix-env-and-docker-compose-inconsistency/260322-lsq-SUMMARY.md` with:
- What was fixed (two bugs from 260322-kkx)
- Commit hash
- Files changed
</output>
