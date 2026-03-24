---
phase: quick
plan: 260324-agv
type: execute
wave: 1
depends_on: []
files_modified:
  - src/config/env.ts
  - src/ingestion/services/extraction-agent.service.ts
  - src/ingestion/services/extraction-agent.service.spec.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "ExtractionAgentService calls OpenRouter with the cv_text and returns parsed structured data"
    - "A real CV produces a non-'Jane Doe' fullName in the extraction result"
    - "If the OpenRouter call fails or times out, extraction returns a safe fallback with null/empty values and does not throw"
    - "OPENROUTER_API_KEY is validated at startup — missing key fails fast"
  artifacts:
    - path: "src/ingestion/services/extraction-agent.service.ts"
      provides: "Real OpenRouter AI extraction replacing mock"
      contains: "createOpenAI"
    - path: "src/config/env.ts"
      provides: "OPENROUTER_API_KEY env var validation"
      contains: "OPENROUTER_API_KEY"
  key_links:
    - from: "src/ingestion/services/extraction-agent.service.ts"
      to: "https://openrouter.ai/api/v1"
      via: "@ai-sdk/openai createOpenAI with baseURL override"
      pattern: "openrouter\\.ai"
    - from: "src/ingestion/ingestion.processor.ts"
      to: "extraction-agent.service.ts"
      via: "constructor injection — no changes needed to processor"
      pattern: "extractionAgent\\.extract"
---

<objective>
Replace the hardcoded mock in ExtractionAgentService with a real OpenRouter API call using
the Vercel AI SDK's `generateObject`. The service must extract structured candidate data
from CV text and handle AI provider failures gracefully without crashing the pipeline.

Purpose: The pipeline currently inserts "Jane Doe" as every candidate's name. This task
makes extraction functional for a real MVP.

Output: A working ExtractionAgentService that calls OpenRouter, validated env config,
and updated unit tests that mock the AI call.
</objective>

<execution_context>
@/Users/danielshalem/triolla/telent-os-backend/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@/Users/danielshalem/triolla/telent-os-backend/.planning/STATE.md
@/Users/danielshalem/triolla/telent-os-backend/src/config/env.ts
@/Users/danielshalem/triolla/telent-os-backend/src/ingestion/services/extraction-agent.service.ts
@/Users/danielshalem/triolla/telent-os-backend/src/ingestion/services/extraction-agent.service.spec.ts
@/Users/danielshalem/triolla/telent-os-backend/src/ingestion/ingestion.module.ts

<interfaces>
<!-- Existing CandidateExtract type — executor MUST preserve this shape (processor depends on it) -->
<!-- From src/ingestion/services/extraction-agent.service.ts -->
```typescript
export type CandidateExtract = z.infer<typeof CandidateExtractSchema> & {
  suspicious: boolean;
};

// CandidateExtractSchema fields used downstream (ingestion.processor.ts):
//   fullName     → candidate INSERT
//   email        → dedup check + candidate INSERT
//   phone        → candidate INSERT
//   currentRole  → candidate enrichment (Phase 7)
//   yearsExperience → candidate enrichment (Phase 7)
//   skills       → candidate enrichment (Phase 7) + scoring input
//   summary      → candidate enrichment (Phase 7) as aiSummary
//   source       → candidate INSERT
//   suspicious   → metadata
```

<!-- ExtractionAgentService constructor — currently no-arg; needs ConfigService injected -->
<!-- From src/ingestion/ingestion.module.ts: ExtractionAgentService is a plain provider -->
<!-- ConfigModule is imported at AppModule level — ConfigService is globally available -->
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Install @ai-sdk/openai and add OPENROUTER_API_KEY to env schema</name>
  <files>package.json, src/config/env.ts</files>
  <action>
    1. Install the OpenAI provider for Vercel AI SDK:
       ```
       npm install @ai-sdk/openai
       ```
       This package provides `createOpenAI` which supports a custom `baseURL` — the standard
       pattern for OpenRouter integration with the Vercel AI SDK.

    2. Add `OPENROUTER_API_KEY` to `src/config/env.ts`:
       ```typescript
       OPENROUTER_API_KEY: z.string().min(1),
       ```
       Insert it alongside `ANTHROPIC_API_KEY`. The existing `ANTHROPIC_API_KEY` validation
       line stays — the Anthropic key is used by the scoring service, not extraction.

    3. Add `OPENROUTER_API_KEY` to the `.env` file (add a placeholder line so the validator
       doesn't crash at startup):
       ```
       OPENROUTER_API_KEY=your-key-here
       ```
       Check if `.env` exists; if it does, append the line. If it does not exist, note it
       in a comment — the user must set this before running.
  </action>
  <verify>
    <automated>cd /Users/danielshalem/triolla/telent-os-backend && npm run build 2>&1 | tail -5</automated>
  </verify>
  <done>
    `npm run build` succeeds. `@ai-sdk/openai` appears in node_modules. `OPENROUTER_API_KEY`
    is present in `src/config/env.ts` envSchema.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Implement real OpenRouter extraction with graceful fallback</name>
  <files>
    src/ingestion/services/extraction-agent.service.ts,
    src/ingestion/services/extraction-agent.service.spec.ts
  </files>
  <behavior>
    - Test: When generateObject resolves, extract() returns the AI result merged with suspicious flag
    - Test: When generateObject rejects (network error, timeout, bad JSON), extract() logs the error
      and returns a safe fallback object with null/empty values — does NOT throw
    - Test: Fallback object shape passes CandidateExtractSchema.parse() (all fields present, types valid)
    - Test: suspicious flag is always propagated from input, including on fallback
  </behavior>
  <action>
    Replace the mock implementation in `src/ingestion/services/extraction-agent.service.ts`.

    **Implementation:**

    ```typescript
    import { Injectable, Logger } from '@nestjs/common';
    import { ConfigService } from '@nestjs/config';
    import { createOpenAI } from '@ai-sdk/openai';
    import { generateObject } from 'ai';
    import { z } from 'zod';

    export const CandidateExtractSchema = z.object({
      fullName: z.string(),
      email: z.string().email().nullable(),
      phone: z.string().nullable(),
      currentRole: z.string().nullable(),
      yearsExperience: z.number().int().nullable(),
      skills: z.array(z.string()),
      summary: z.string().nullable(),
      source: z.enum(['direct', 'agency', 'linkedin', 'referral', 'website']).default('direct'),
    });

    export type CandidateExtract = z.infer<typeof CandidateExtractSchema> & {
      suspicious: boolean;
    };

    const FALLBACK: Omit<CandidateExtract, 'suspicious'> = {
      fullName: '',
      email: null,
      phone: null,
      currentRole: null,
      yearsExperience: null,
      skills: [],
      summary: null,
      source: 'direct',
    };

    const SYSTEM_PROMPT = `You are a CV data extraction assistant.
    Extract structured candidate information from the provided email and CV text.
    Source detection rules:
    - 'agency': email includes recruiter name + agency name + "on behalf of"
    - 'linkedin': subject contains "LinkedIn"
    - 'referral': body mentions "referred by"
    - Default to 'direct'
    Summary (ai_summary): exactly 2 sentences — sentence 1 is role/experience level,
    sentence 2 highlights top skills or notable achievement.
    Ambiguous content: still attempt extraction; do not throw.
    If a field cannot be determined, use null.`;

    @Injectable()
    export class ExtractionAgentService {
      private readonly logger = new Logger(ExtractionAgentService.name);

      constructor(private readonly config: ConfigService) {}

      async extract(fullText: string, suspicious: boolean): Promise<CandidateExtract> {
        const apiKey = this.config.get<string>('OPENROUTER_API_KEY')!;

        const openrouter = createOpenAI({
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey,
        });

        try {
          const { object } = await generateObject({
            model: openrouter('google/gemma-3-12b-it:free'),
            schema: CandidateExtractSchema,
            system: SYSTEM_PROMPT,
            prompt: `Extract candidate information from the following text:\n\n${fullText}`,
          });
          return { ...object, suspicious };
        } catch (err) {
          this.logger.error(
            `OpenRouter extraction failed — returning fallback. Reason: ${(err as Error).message}`,
          );
          return { ...FALLBACK, suspicious };
        }
      }
    }
    ```

    **Key choices:**
    - Model: `google/gemma-3-12b-it:free` — capable free-tier model on OpenRouter, good at
      structured JSON output. Falls back gracefully if quota exceeded.
    - `generateObject` with `CandidateExtractSchema` gives Zod-validated output — no
      hallucination risk on field types.
    - Fallback with `fullName: ''` — the processor already handles empty fullName by marking
      the intake as 'failed' and returning (line 116-125 of ingestion.processor.ts). This
      preserves the existing error-handling contract without changes to the processor.
    - `ConfigService` injection: ExtractionAgentService is a plain NestJS provider in
      IngestionModule; ConfigModule is global — no module change needed.

    **Update `src/ingestion/services/extraction-agent.service.spec.ts`:**

    The existing tests assert mock return values. Replace with tests that:
    1. Mock `generateObject` from 'ai' module to return a resolved object
    2. Assert the result matches the AI output + suspicious flag
    3. Mock `generateObject` to reject — assert fallback is returned, not thrown
    4. Assert fallback shape passes CandidateExtractSchema.parse()
    5. Assert suspicious flag propagates in both success and fallback cases

    Use `jest.mock('ai', ...)` at the top of the spec. Inject a mock ConfigService
    that returns a fake API key. Preserve the exported `mockCandidateExtract` helper —
    other specs import it.

    The `mockCandidateExtract` helper MUST remain exported with the same signature.
    Update it to return a valid `CandidateExtract` matching the current schema (no behavior
    change, just ensure it still satisfies TypeScript).
  </action>
  <verify>
    <automated>cd /Users/danielshalem/triolla/telent-os-backend && npx jest src/ingestion/services/extraction-agent.service.spec.ts --no-coverage 2>&1</automated>
  </verify>
  <done>
    All tests in extraction-agent.service.spec.ts pass. The service no longer contains
    'Jane Doe' hardcoded. `npm test` full suite still passes (other specs that import
    `mockCandidateExtract` still compile and run).
  </done>
</task>

</tasks>

<verification>
After both tasks complete, run the full test suite:

```bash
cd /Users/danielshalem/triolla/telent-os-backend && npm test 2>&1 | tail -20
```

All existing tests must pass. Then verify the build:

```bash
npm run build 2>&1 | tail -5
```

No TypeScript errors.
</verification>

<success_criteria>
- `npm test` passes all suites (no regressions — currently 86+ tests passing)
- `npm run build` compiles without errors
- `src/ingestion/services/extraction-agent.service.ts` contains no reference to 'Jane Doe'
- `generateObject` from 'ai' is called with OpenRouter baseURL in the real implementation
- Fallback path returns `{ fullName: '', suspicious, skills: [], ... }` without throwing
- `OPENROUTER_API_KEY` is validated in `src/config/env.ts`
</success_criteria>

<output>
After completion, update `.planning/STATE.md` Quick Tasks Completed table with:

| 260324-agv | Replace Mock AI Extraction with OpenRouter MVP | 2026-03-24 | {commit-hash} | [260324-agv-replace-mock-ai-extraction-with-openrout](./quick/260324-agv-replace-mock-ai-extraction-with-openrout/) |
</output>
