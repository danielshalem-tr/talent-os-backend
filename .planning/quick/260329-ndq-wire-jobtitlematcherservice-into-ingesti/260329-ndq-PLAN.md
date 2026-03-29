---
phase: quick-260329-ndq
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/ingestion/ingestion.processor.ts
autonomous: true
requirements: [QUICK-260329-ndq]

must_haves:
  truths:
    - "Phase 6.5 uses JobTitleMatcherService.matchJobTitles() for semantic comparison"
    - "Iteration stops at first job that meets confidence > 0.7 (early exit saves API calls)"
    - "calculateSimilarity() and levenshteinDistance() no longer exist in ingestion.processor.ts"
  artifacts:
    - path: "src/ingestion/ingestion.processor.ts"
      provides: "IngestionProcessor with JobTitleMatcherService injected and Phase 6.5 rewritten"
      contains: "JobTitleMatcherService"
  key_links:
    - from: "src/ingestion/ingestion.processor.ts"
      to: "src/scoring/job-title-matcher.service.ts"
      via: "constructor injection"
      pattern: "private readonly jobTitleMatcher: JobTitleMatcherService"
---

<objective>
Wire JobTitleMatcherService into IngestionProcessor and replace the Levenshtein-based Phase 6.5 job title matching with semantic AI matching.

Purpose: The existing calculateSimilarity()/levenshteinDistance() functions produce poor matches for job title variations (e.g., "Frontend Dev" vs "Web Engineer"). JobTitleMatcherService uses Claude Haiku via generateObject() for semantically aware matching.

Output: ingestion.processor.ts with JobTitleMatcherService injected, Phase 6.5 rewritten to use it with early-exit on first confident match, and the two dead functions deleted.
</objective>

<execution_context>
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/workflows/execute-plan.md
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

# Key interfaces already available — no module changes needed.
# ScoringModule already exports JobTitleMatcherService.
# IngestionModule already imports ScoringModule.
</context>

<interfaces>
<!-- From src/scoring/job-title-matcher.service.ts -->
```typescript
export interface JobTitleMatchResult {
  matched: boolean;
  confidence: number; // 0-1 decimal (already normalized from 0-100 AI output)
  reasoning?: string;
  error?: string;
}

// Injectable service exported from ScoringModule
class JobTitleMatcherService {
  async matchJobTitles(
    candidateJobTitle: string,
    positionJobTitle: string,
    tenantId: string
  ): Promise<JobTitleMatchResult>
}
```

<!-- From src/ingestion/ingestion.processor.ts — current Phase 6.5 (lines 217-269) -->
<!-- Uses: this.calculateSimilarity(extraction!.job_title_hint, job.title) -->
<!-- Iterates all active jobs, tracks bestSimilarity, picks best match -->
<!-- Private methods to delete: calculateSimilarity(), levenshteinDistance() (lines 371-399) -->
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Inject JobTitleMatcherService and rewrite Phase 6.5 with early-exit semantic matching</name>
  <files>src/ingestion/ingestion.processor.ts</files>
  <action>
    1. Add import at top of file:
       `import { JobTitleMatcherService } from '../scoring/job-title-matcher.service';`

    2. Add `private readonly jobTitleMatcher: JobTitleMatcherService` as the last parameter in the constructor (after `scoringService`). No module changes needed — ScoringModule already exports it and IngestionModule already imports ScoringModule.

    3. Rewrite Phase 6.5 block (currently lines 217-269) replacing the for-loop + calculateSimilarity logic:

    ```typescript
    // Phase 6.5: Semantic job title matching (early-exit on first confident match)
    let matchedJob: { id: string; title: string; hiringStages: { id: string }[] } | null = null;

    if (extraction!.job_title_hint) {
      const activeJobs = await this.prisma.job.findMany({
        where: { tenantId, status: 'open' },
        select: {
          id: true,
          title: true,
          hiringStages: {
            where: { isEnabled: true },
            orderBy: { order: 'asc' },
            take: 1,
          },
        },
      });

      for (const job of activeJobs) {
        const matchResult = await this.jobTitleMatcher.matchJobTitles(
          extraction!.job_title_hint,
          job.title,
          tenantId,
        );

        if (matchResult.confidence > 0.7) {
          matchedJob = job;
          this.logger.log(
            `Phase 6.5: matched job "${job.title}" with confidence ${matchResult.confidence.toFixed(2)} — ${matchResult.reasoning ?? ''}`,
          );
          break; // Early exit — first confident match wins, saves API calls
        }
      }

      if (!matchedJob) {
        this.logger.warn(
          `Phase 6.5: no active job matched title hint "${extraction!.job_title_hint}" above confidence threshold 0.7`,
        );
      }
    }
    ```

    4. Remove the old `bestSimilarity` variable references and the two `if (bestSimilarity < 0.7)` guard blocks — the new loop handles threshold internally via `break`.

    5. Delete private methods `calculateSimilarity()` and `levenshteinDistance()` entirely (currently at the bottom of the file, lines 371-399).

    6. Update the "Phase 6.5 complete" log line (currently references `bestSimilarity`) to use the new match result — the log is now inside the loop (step 3 above), so remove or replace the old post-loop log that references `bestSimilarity.toFixed(2)`.

    IMPORTANT: Do NOT change any Phase 7 logic (scoring, application upsert, candidateJobScore INSERT). The `matchedJob` variable shape must remain compatible: `{ id, title, hiringStages: [{ id }] }` so downstream `jobId`, `hiringStageId`, and `activeJob` references continue to work unchanged.
  </action>
  <verify>
    <automated>cd /Users/danielshalem/triolla/telent-os-backend && npx tsc --noEmit 2>&1 | head -30 && npm test -- --testPathPattern="ingestion.processor" --passWithNoTests 2>&1 | tail -20</automated>
  </verify>
  <done>
    - TypeScript compiles with no errors
    - ingestion.processor.ts imports JobTitleMatcherService
    - Constructor includes jobTitleMatcher parameter
    - Phase 6.5 loop calls matchJobTitles() and breaks on confidence > 0.7
    - calculateSimilarity() and levenshteinDistance() are gone from the file
  </done>
</task>

</tasks>

<verification>
`npx tsc --noEmit` passes clean.
`grep -n "calculateSimilarity\|levenshteinDistance"` returns no matches in ingestion.processor.ts.
`grep -n "jobTitleMatcher\|JobTitleMatcherService"` returns constructor injection + import + usage in Phase 6.5.
</verification>

<success_criteria>
- JobTitleMatcherService is injected into IngestionProcessor constructor
- Phase 6.5 iterates active jobs and calls matchJobTitles() per job, stopping on first result with confidence > 0.7
- calculateSimilarity() and levenshteinDistance() are deleted from the file
- TypeScript compiles without errors
- No regression in existing tests
</success_criteria>

<output>
After completion, create `.planning/quick/260329-ndq-wire-jobtitlematcherservice-into-ingesti/260329-ndq-SUMMARY.md`
</output>
