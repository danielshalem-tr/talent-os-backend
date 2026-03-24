# Schema Migration Plan — Job Creation Feature

## Context

Adding a full job creation UI. This requires restructuring the `Job` model and adding support for per-job hiring stages (linked to `Application.stage`) and screening questions.

---

## 1. New Models to Add

### `JobStage`

```prisma
model JobStage {
  id                String  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId          String  @map("tenant_id") @db.Uuid
  jobId             String  @map("job_id") @db.Uuid
  name              String  @db.Text
  order             Int     @db.SmallInt
  responsibleUserId String? @map("responsible_user_id") @db.Text
  isCustom          Boolean @default(false) @map("is_custom")

  job          Job           @relation(fields: [jobId], references: [id], onDelete: Cascade)
  applications Application[]

  @@index([jobId, order])
  @@map("job_stages")
}
```

### `ScreeningQuestion`

```prisma
model ScreeningQuestion {
  id         String  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId   String  @map("tenant_id") @db.Uuid
  jobId      String  @map("job_id") @db.Uuid
  text       String  @db.Text
  answerType String  @map("answer_type") @db.Text
  required   Boolean @default(false)
  knockout   Boolean @default(false)
  order      Int     @db.SmallInt

  job Job @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@index([jobId])
  @@map("screening_questions")
}
```

> `answerType` values: `"yes_no" | "text" | "multiple_choice" | "file_upload"`

---

## 2. Modify `Job` Model

**Add fields:**

```prisma
roleSummary       String?  @map("role_summary") @db.Text
responsibilities  String?  @db.Text
whatWeOffer       String?  @map("what_we_offer") @db.Text
mustHaveSkills    String[] @default([]) @map("must_have_skills")
niceToHaveSkills  String[] @default([]) @map("nice_to_have_skills")
expYearsMin       Int?     @map("exp_years_min") @db.SmallInt
expYearsMax       Int?     @map("exp_years_max") @db.SmallInt
preferredOrgTypes String[] @default([]) @map("preferred_org_types")
```

**Add relations:**

```prisma
screeningQuestions ScreeningQuestion[]
hiringStages       JobStage[]
```

**⚠️ Before removing old fields — check first:**

- `description` → migrate data into `roleSummary` (or keep both temporarily)
- `requirements String[]` → check if any code reads/writes this field before dropping it
- `hiringManager String?` → the UI suggests this becomes a user reference; check if it should stay as free text or become a FK. **Do not change this unless you confirm the pattern used elsewhere in the codebase.**

---

## 3. Modify `Application` Model

Replace the free-text `stage` field with a FK to `JobStage`:

```prisma
// Add:
jobStageId String? @map("job_stage_id") @db.Uuid
jobStage   JobStage? @relation(fields: [jobStageId], references: [id])

// Remove (after migration):
// stage String @default("new") @db.Text
```

**⚠️ Before removing `stage`:**

- Search the codebase for all reads/writes of `application.stage`
- The existing values (`"new"`, etc.) need to be mapped to `JobStage` records or the field kept as a fallback during transition
- The index `idx_applications_stage` on `[tenantId, stage]` will need to be replaced with one on `[tenantId, jobStageId]`

---

## 4. Migration Steps (in order)

1. Add new models `JobStage` and `ScreeningQuestion`
2. Add new fields to `Job` (all nullable/defaulted — non-breaking)
3. Add `jobStageId` to `Application` as nullable (non-breaking)
4. Write a data migration script if existing `description`/`requirements`/`stage` data needs to be preserved
5. Once all app code is updated, drop old fields and the old index

---

## Open Questions for Agent

- [ ] Is `hiringManager` on `Job` currently stored as a name string or a user ID? Check before deciding whether to change it.
- [ ] Are there any API routes, services, or background jobs that read `Application.stage` directly? List them — they need to be updated before removing the field.
- [ ] Is there a `User` or `Employee` model not shown in the schema? `responsibleUserId` on `JobStage` should probably be a FK to it.
- [ ] Is there a predefined list of "default" hiring stages (e.g. Application review, Screening, Interview, Offer) that should be seeded per tenant or per job on creation?
- [ ] Does `tenantId` need to be added to `JobStage` and `ScreeningQuestion` for RLS/filtering, or is filtering always done via the parent `jobId`? (Currently included in the proposal — verify this is consistent with the rest of the codebase.)
