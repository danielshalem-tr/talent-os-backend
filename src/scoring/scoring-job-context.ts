import { Prisma } from '@prisma/client';

/**
 * The job fields the scorer sees. Every scoring call site MUST build its job via
 * `scoringJobSelect` + `toScoringJob` — the ingestion path once selected the dead
 * `requirements` column (always []) while the assign paths sent `mustHaveSkills`, so the
 * same CV scored differently depending on how it entered. One select, one mapper, no drift.
 */
export interface ScoringJob {
  title: string;
  description: string | null;
  roleSummary: string | null;
  responsibilities: string | null;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  expYearsMin: number | null;
  expYearsMax: number | null;
  preferredOrgTypes: string[];
  screeningQuestions: string[];
}

export const scoringJobSelect = {
  title: true,
  description: true,
  roleSummary: true,
  responsibilities: true,
  mustHaveSkills: true,
  niceToHaveSkills: true,
  expYearsMin: true,
  expYearsMax: true,
  preferredOrgTypes: true,
  screeningQuestions: { select: { text: true } },
} satisfies Prisma.JobSelect;

export type ScoringJobRow = Prisma.JobGetPayload<{ select: typeof scoringJobSelect }>;

export function toScoringJob(row: ScoringJobRow): ScoringJob {
  return {
    title: row.title,
    description: row.description ?? null,
    roleSummary: row.roleSummary ?? null,
    responsibilities: row.responsibilities ?? null,
    mustHaveSkills: row.mustHaveSkills ?? [],
    niceToHaveSkills: row.niceToHaveSkills ?? [],
    expYearsMin: row.expYearsMin ?? null,
    expYearsMax: row.expYearsMax ?? null,
    preferredOrgTypes: row.preferredOrgTypes ?? [],
    screeningQuestions: (row.screeningQuestions ?? []).map((q) => q.text),
  };
}
