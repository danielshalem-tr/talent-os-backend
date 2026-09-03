import { z } from 'zod';
import type { ScoringInput } from './scoring.service';

export const MAX_CV_LENGTH = 15_000;
const MAX_FIELD_LENGTH = 6_000;

export const RequirementEvaluationSchema = z.object({
  requirement: z.string(),
  kind: z.enum(['skill', 'tool', 'credential', 'experience', 'domain', 'other']),
  status: z.enum(['met', 'partial', 'missing']),
  evidence: z.string(),
  evidence_strength: z.enum(['demonstrated', 'claimed', 'none']),
  exact_match: z.boolean(),
});

export const EvaluationSchema = z.object({
  must_haves: z.array(RequirementEvaluationSchema),
  nice_to_haves: z.array(RequirementEvaluationSchema),
  // Clamp rather than reject: a model that says "55 years" or "105" must not fail the whole
  // intake (generateObject throws on schema violations and ingestion marks the email failed).
  relevant_years: z
    .number()
    .nullable()
    .transform((v) => (v == null ? null : Math.min(50, Math.max(0, v)))),
  role_relevance: z.number().transform((v) => Math.min(100, Math.max(0, v))),
  cv_informative: z.boolean(),
  reasoning: z.string(),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
});

export const SCORING_SYSTEM_PROMPT = `You are a senior technical recruiter auditing a CV against a job. You do NOT produce a score. You produce a precise, evidence-backed evaluation; a deterministic policy computes the score from it.

Evaluate EVERY must-have and nice-to-have requirement, one entry each, in the order given, copying the requirement text verbatim into "requirement".

For each requirement:
- kind: skill (technology/language/framework — INCLUDING when years are attached, e.g. "3+ years React" is a skill; judge the technology, the years go into relevant_years), tool (a named product such as an IDE, AI assistant, SaaS), credential (degree, certification, license), experience (ONLY a bare tenure/seniority statement such as "5+ years of experience" or "senior-level"; a requirement that names a technology, activity or system — e.g. "Experience integrating with APIs and databases" — is a skill even though it starts with the word Experience), domain (industry/business knowledge), other.
- status: met = clearly satisfied by the CV; partial = some but not all of it, or weaker than asked; missing = no evidence.
- Compound requirements written as "A+B", "A and B", "A/B" are satisfied only when EVERY component is; report the status of the WEAKEST component and name it in evidence.
- evidence: a short quote (max 25 words) from the CV that supports the status, or "not found".
- evidence_strength: demonstrated = used in a described role or project; claimed = appears only in a skills/keywords list or self-description; none = missing.
- Tool requirements are met by demonstrated use of an equivalent tool in the same category (e.g. another AI coding assistant for a named one). Set exact_match=true only when the exact named tool appears.
- Credential requirements: report status honestly; a bootcamp or diploma is not a bachelor's degree, while a higher degree (master's, PhD) fully satisfies a bachelor's requirement. Never infer a degree that is not written.
- exact_match is only meaningful for kind=tool; set it false for every other kind.

Also return:
- relevant_years: professional years relevant to this role's function, computed from the CV's work history (start/end dates). Exclude education, military service and internships unless clearly professional roles. Do not trust the extracted "years" hint if the CV contradicts it. null only if no dates exist.
- role_relevance (0-100): how closely the candidate's actual career function matches this role's function (a product manager applying to a developer role is ~10; a backend developer applying to a full-stack role is ~75).
- cv_informative: false when the CV text is too short or garbled to judge.
- reasoning: 2-3 sentences for a recruiter. strengths: 2-5 specific items. gaps: 0-5 specific items.

Rules: base everything on the CV text only. Never assume unstated skills. Self-description that mirrors the job wording without a supporting role or project counts as claimed, not demonstrated. CVs may be in Hebrew or English; answer in English.`;

function clip(s: string | null | undefined, max: number): string {
  return (s ?? '').substring(0, max);
}

function numbered(prefix: string, items: string[]): string {
  return items.length === 0 ? 'none' : items.map((it, i) => `${prefix}${i + 1}. ${it}`).join('\n');
}

export function buildScoringUserPrompt(input: ScoringInput): string {
  const { job, candidateFields } = input;
  const range =
    job.expYearsMin == null && job.expYearsMax == null
      ? 'not specified'
      : `${job.expYearsMin ?? '?'}-${job.expYearsMax ?? '?'} years`;

  return [
    'JOB',
    `Title: ${job.title}`,
    `Role summary: ${clip(job.roleSummary, MAX_FIELD_LENGTH) || 'n/a'}`,
    `Description: ${clip(job.description, MAX_FIELD_LENGTH) || 'n/a'}`,
    `Responsibilities: ${clip(job.responsibilities, MAX_FIELD_LENGTH) || 'n/a'}`,
    `Experience range: ${range}`,
    `Preferred background: ${job.preferredOrgTypes.length ? job.preferredOrgTypes.join(', ') : 'n/a'}`,
    'Must-have requirements:',
    numbered('M', job.mustHaveSkills),
    `Nice-to-have requirements: ${job.niceToHaveSkills.length ? '' : 'none'}`,
    ...(job.niceToHaveSkills.length ? [numbered('N', job.niceToHaveSkills)] : []),
    `Screening questions the hiring manager cares about (context only): ${
      job.screeningQuestions.length ? job.screeningQuestions.join(' | ') : 'none'
    }`,
    '',
    'CANDIDATE (auto-extracted hints — may be wrong; the CV text below is authoritative)',
    `Current role hint: ${candidateFields.currentRole ?? 'unknown'}`,
    `Years hint: ${candidateFields.yearsExperience ?? 'unknown'}`,
    `Skills hint: ${candidateFields.skills.length ? candidateFields.skills.join(', ') : 'none'}`,
    '',
    'CV TEXT',
    clip(input.cvText, MAX_CV_LENGTH),
  ].join('\n');
}
