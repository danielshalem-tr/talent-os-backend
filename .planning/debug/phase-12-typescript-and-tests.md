---
status: investigating
trigger: "Phase 12 TypeScript build errors and test failures"
created: 2026-03-26T00:00:00Z
updated: 2026-03-26T00:00:00Z
---

## Current Focus

hypothesis: Five distinct errors with distinct root causes — all fixable
test: Read all 5 affected files and check schema/type definitions
expecting: Fixes to each root cause will make build pass and all 217 tests pass
next_action: Apply fixes systematically

## Symptoms

expected: Phase 12 code compiles and all 217 tests pass
actual: Build fails with 5 TypeScript errors; 5 test failures in candidates module
errors:
  1. TS2694: Namespace 'global.Express' has no exported member 'Multer' — candidates.controller.ts:19 and candidates.service.ts:134
  2. TS2561: 'id_tenantId' does not exist in JobWhereUniqueInput — candidates.service.ts:140
  3. TS2322: Type 'null' is not assignable to NullableJsonNullValueInput — candidates.service.ts:207
  4. TS2769: z.enum() doesn't accept 'errorMap' parameter — create-candidate.dto.ts:6
  5. Test failures: 5 tests failed, 2 test suites failed
reproduction: npm run build; npm test
started: Phase 12 code just added

## Eliminated

(none yet)

## Evidence

- timestamp: 2026-03-26T00:00:00Z
  checked: Job model in prisma/schema.prisma
  found: Job model has only a single @id on the 'id' field — no @@unique([id, tenantId]) composite constraint
  implication: Prisma does NOT generate an id_tenantId composite key for Job; the correct lookup is findFirst with {id, tenantId} or just findUnique({where: {id}})

- timestamp: 2026-03-26T00:00:00Z
  checked: node_modules/@types/multer
  found: @types/multer is NOT installed; multer package is present but without TS type declarations
  implication: Express.Multer.File is unavailable; need to install @types/multer OR use a local type definition

- timestamp: 2026-03-26T00:00:00Z
  checked: create-candidate.dto.ts
  found: z.enum() called with {errorMap: ...} as second arg — Zod v4 removed errorMap option from z.enum()
  implication: Need to use .superRefine() or just remove errorMap; or use z.enum([...]).refine(). Actually Zod v3 supports errorMap in z.enum, need to check zod version.

- timestamp: 2026-03-26T00:00:00Z
  checked: candidates.service.ts line 207
  found: metadata: null passed to Prisma create — Prisma JsonNullValueInput requires Prisma.JsonNull not raw null for nullable JSON fields
  implication: Need to use Prisma.JsonNull or cast appropriately

## Resolution

root_cause: |
  1. @types/multer not installed → Express.Multer.File type missing
  2. Job has no @@unique([id, tenantId]) → id_tenantId composite key doesn't exist in Prisma client
  3. Prisma nullable JSON field requires Prisma.JsonNull not raw null
  4. z.enum() errorMap option removed or incompatible with installed Zod version
fix: (applying below)
verification: (pending)
files_changed: []
