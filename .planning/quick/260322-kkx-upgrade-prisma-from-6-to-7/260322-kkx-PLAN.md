---
phase: quick
plan: 260322-kkx
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - prisma/schema.prisma
  - prisma/prisma.config.ts
  - src/prisma/prisma.service.ts
  - CLAUDE.md
autonomous: true
requirements: []

must_haves:
  truths:
    - "npm install resolves prisma@^7 and @prisma/client@^7 without conflicts"
    - "prisma generate succeeds with prisma.config.ts providing DATABASE_URL"
    - "tsc compiles clean (zero errors)"
    - "PrismaService unit tests pass"
  artifacts:
    - path: "prisma/prisma.config.ts"
      provides: "Prisma 7 config with DATABASE_URL from env"
    - path: "prisma/schema.prisma"
      provides: "Updated schema without datasource url (moved to prisma.config.ts)"
  key_links:
    - from: "prisma/prisma.config.ts"
      to: "prisma/schema.prisma"
      via: "Prisma 7 config resolution"
      pattern: "defineConfig"
    - from: "src/prisma/prisma.service.ts"
      to: "@prisma/client"
      via: "extends PrismaClient"
      pattern: "PrismaClient"
---

<objective>
Upgrade Prisma from 6 to 7: bump package versions, migrate datasource URL configuration to the new prisma.config.ts file, and verify the TypeScript compiler is clean.

Purpose: Prisma 7 is the current stable release. The datasource URL configuration now lives in prisma.config.ts instead of schema.prisma — this is the canonical Prisma 7 pattern.
Output: prisma@^7 installed, prisma.config.ts created, schema.prisma cleaned up, CLAUDE.md constraint updated, zero tsc errors.
</objective>

<execution_context>
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/workflows/execute-plan.md
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@package.json
@prisma/schema.prisma
@src/prisma/prisma.service.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Upgrade Prisma packages and migrate datasource config to prisma.config.ts</name>
  <files>package.json, prisma/prisma.config.ts, prisma/schema.prisma, CLAUDE.md</files>
  <action>
1. Update package.json: change `"prisma": "^6.19.2"` to `"prisma": "^7.0.0"` and `"@prisma/client": "^6.19.2"` to `"@prisma/client": "^7.0.0"`, then run `npm install` in the repo root.

2. Create `prisma/prisma.config.ts` with the Prisma 7 defineConfig pattern:

```ts
import { defineConfig } from 'prisma/config';

export default defineConfig({
  datasources: {
    db: {
      url: process.env.DATABASE_URL!,
    },
  },
});
```

3. Update `prisma/schema.prisma`: remove the `url` line from the `datasource db` block (the URL is now in prisma.config.ts). The datasource block becomes:

```prisma
datasource db {
  provider = "postgresql"
}
```

   Keep the `generator client` block unchanged.

4. Update `CLAUDE.md`: in the Constraints section, change `Prisma 6` to `Prisma 7` in the Tech Stack line.

5. Run `npm run build` (or `npx tsc --noEmit`) to check for compile errors. If `defineConfig` import path differs in the installed version, check `node_modules/prisma/config` exists; if not, try `prisma/prisma-config` or check the Prisma 7 exports map via `cat node_modules/prisma/package.json | grep -A5 '"exports"'` and use the correct import path.

6. Run `npx prisma generate` to regenerate the Prisma client against the new config.
  </action>
  <verify>
    <automated>cd /Users/danielshalem/triolla/telent-os-backend && node -e "const p = require('./node_modules/prisma/package.json'); console.log('prisma version:', p.version)" && node -e "const p = require('./node_modules/@prisma/client/package.json'); console.log('@prisma/client version:', p.version)"</automated>
  </verify>
  <done>Both prisma and @prisma/client report version 7.x. prisma.config.ts exists. schema.prisma datasource block has no url field. CLAUDE.md says Prisma 7.</done>
</task>

<task type="auto">
  <name>Task 2: Verify tsc compiles clean and unit tests pass</name>
  <files>src/prisma/prisma.service.ts</files>
  <action>
1. Run `npx tsc --noEmit` from the repo root. Fix any type errors that emerged from the Prisma 7 upgrade:
   - If `PrismaClient` constructor signature changed, update `prisma.service.ts` accordingly (e.g., Prisma 7 may require passing config explicitly or may have changed `$connect` / `$disconnect` typings).
   - Common Prisma 7 change: `PrismaClientOptions` moved or was renamed — update the import if needed.
   - If `PrismaService extends PrismaClient` causes errors, check if Prisma 7 recommends composition over inheritance; if so, refactor to hold a private `client: PrismaClient` instance and delegate `$connect`/`$disconnect`/`$transaction` calls. Only refactor if tsc actually errors — do not refactor speculatively.

2. Run `npm test -- --testPathPattern=prisma.service` to confirm the three PrismaService unit tests still pass.

3. Update STATE.md: change `Prisma 6` to `Prisma 7` in the Tech Stack line under "Accumulated Context".
  </action>
  <verify>
    <automated>cd /Users/danielshalem/triolla/telent-os-backend && npx tsc --noEmit && npm test -- --testPathPattern=prisma.service --passWithNoTests</automated>
  </verify>
  <done>tsc exits 0 (no type errors). PrismaService unit tests (3 assertions) pass. STATE.md reflects Prisma 7.</done>
</task>

</tasks>

<verification>
- `node_modules/prisma/package.json` version field starts with `7.`
- `prisma/prisma.config.ts` exists and exports a defineConfig default
- `prisma/schema.prisma` datasource block contains no `url =` line
- `npx tsc --noEmit` exits 0
- `npm test -- --testPathPattern=prisma.service` passes all 3 assertions
- CLAUDE.md Constraints says `Prisma 7`
- STATE.md Tech Stack says `Prisma 7`
</verification>

<success_criteria>
Prisma 7 is installed, datasource URL is configured via prisma.config.ts, TypeScript compiles without errors, all PrismaService tests pass, and both documentation files (CLAUDE.md, STATE.md) reference Prisma 7.
</success_criteria>

<output>
After completion, create `.planning/quick/260322-kkx-upgrade-prisma-from-6-to-7/260322-kkx-SUMMARY.md` summarising what changed, any issues encountered, and final version numbers.
</output>
