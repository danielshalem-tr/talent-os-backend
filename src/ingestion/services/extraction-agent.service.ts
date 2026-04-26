import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateObject } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { StorageService } from '../../storage/storage.service';

export const CandidateExtractSchema = z.object({
  full_name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  current_role: z.string().nullable(),
  years_experience: z.coerce.number().min(0).max(50).transform(Math.round).nullable(),
  location: z.string().nullable(),
  skills: z.array(z.string()),
  ai_summary: z.string().nullable(),
  source_hint: z.enum(['linkedin', 'agency', 'referral', 'direct']).nullable(),
  source_agency: z.string().nullable(),
});

export type CandidateExtract = z.infer<typeof CandidateExtractSchema> & {
  suspicious: boolean;
};

/**
 * Known agency domain → canonical name map.
 * Deterministic resolution — never rely on AI for these.
 * Keys are lowercase domain strings (without port).
 * BUG-3 fix: 'allJobs' corrected to 'AllJobs' (matches the actual brand name).
 */
const KNOWN_AGENCY_DOMAINS: Record<string, string> = {
  'jobhunt.co.il': 'jobhunt',
  'alljob.co.il': 'AllJobs',
};

/**
 * Resolve a canonical agency name from a sender email address.
 * Returns the canonical name if the domain is known, otherwise null.
 * Example: "talent@jobhunt.co.il" → "jobhunt"
 */
function resolveAgencyFromEmail(fromEmail: string): string | null {
  try {
    const atIndex = fromEmail.indexOf('@');
    if (atIndex === -1) return null;
    const domain = fromEmail
      .slice(atIndex + 1)
      .toLowerCase()
      .split(':')[0]
      .trim();
    return KNOWN_AGENCY_DOMAINS[domain] ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the system prompt with the current year injected dynamically.
 * This avoids stale year values if the process runs across a year boundary.
 */
function buildInstructions(currentYear: number): string {
  return `You are a CV data extraction assistant for an Israeli recruiting platform.

## Output format
Return ONLY a raw JSON object — no markdown, no code fences, no explanation, no trailing text.

## Language handling
The CV may be in Hebrew, English, or a mix of both.
- full_name: return the name exactly as it appears in the CV. If written in Hebrew, return Hebrew. If in English, return English. Do not transliterate or translate names.
- current_role, skills, ai_summary: return in English. Translate from Hebrew if needed.
- location: return in English "City, Country" format. Translate city names if needed (e.g. "תל אביב" → "Tel Aviv, Israel").

## Fields — extract exactly these keys:

full_name (string, required)
  Use empty string "" only if the name is truly undetectable.

email (string or null)
  The candidate's personal email address.

phone (string or null)
  Normalize to international format. Israeli mobile prefixes: 052, 053, 054, 055, 058 → country code +972. Example: "052-4203543" → "+972-52-4203543".

current_role (string or null)
  The candidate's current or most recent job title, in English.

years_experience (integer or null)
  Total years of ACTUAL professional experience as a SINGLE INTEGER.
  Follow this priority:
    1. If the candidate explicitly states total experience (e.g. "10 years of experience", "10+ שנות ניסיון"), use that number.
    2. If not stated, calculate from the work history: sum the durations of each listed position from the earliest start year to ${currentYear}. If only a start year is listed for the current role with no end date, assume it continues to ${currentYear}.
    3. If there are gaps between positions (e.g. one role ends 2022 and the next starts 2025), count ONLY the actual years worked — do not include gap years. Also mention the gaps in ai_summary (see below).
    4. Convert ranges (e.g. "5-7 years") to the midpoint rounded to nearest integer.
    5. Exclude education, internships, and military service unless the role was clearly professional.
    6. Return null only if no experience data exists at all.

location (string or null)
  The candidate's HOME location — where they LIVE or are BASED — in "City, Country" format.
  IMPORTANT: Do NOT use the employer's country or the job's location. A candidate who worked at "VAA Philippines" or "Google US" may live in Israel.
  Use signals in this priority order:
    1. Explicit location/address line in the CV (e.g. "Tel Aviv, Israel" or "תל אביב")
    2. Phone country prefix: +972 or Israeli mobile prefix (052/053/054/055/058) → Israel
    3. LinkedIn URL with country indicator
    4. Personal email domain (.co.il, etc.)
  If none of these signals exist, return null — do not guess from employer location.

skills (array of strings)
  5 to 15 short tags in English, lowercase. Include both technical and domain/management skills.
  Examples: "node.js", "python", "team leadership", "product management", "saas operations"

ai_summary (string or null)
  2-3 sentences in English, recruiter-focused:
    - Sentence 1: role/seniority level and total years of experience.
    - Sentence 2: top 2-3 skills or a standout achievement.
    - Sentence 3 (only if applicable): note any employment gaps found in the work history (e.g. "Note: ~2 year gap between Role X (ended 2022) and Role Y (started 2025)."). If there are no gaps, omit this sentence entirely — do not write "No gaps found."

source_hint ("linkedin" | "agency" | "referral" | "direct" | null)
  Infer from the email metadata (Subject + From):
  - "linkedin": From or Subject mentions LinkedIn or LinkedIn Recruiter
  - "agency": from a recruiting agency domain, or Subject says "presenting candidate" / "מציג מועמד"
  - "referral": body mentions "referred by" / "הומלץ על ידי"
  - "direct": sent directly by the candidate themselves
  - null: cannot determine

source_agency (string or null)
  IMPORTANT: If a "Resolved Agency Name" line appears in the email metadata section, use that exact value and set source_hint to "agency" — do not override it.
  Otherwise: if source_hint is "agency", extract the agency name from From name/domain or Subject. Return null if not an agency or name is unknown.

## Examples

English CV, direct application:
{
  "full_name": "Dana Cohen",
  "email": "dana.cohen@gmail.com",
  "phone": "+972-52-1234567",
  "current_role": "Senior Backend Developer",
  "years_experience": 6,
  "location": "Tel Aviv, Israel",
  "skills": ["node.js", "typescript", "postgresql", "docker", "aws", "system design"],
  "ai_summary": "Senior Backend Developer with 6 years of experience in server-side development. Specializes in Node.js and cloud infrastructure with a track record of leading microservices migrations.",
  "source_hint": "direct",
  "source_agency": null
}

Hebrew CV with employment gap, agency submission (Resolved Agency Name: jobhunt):
{
  "full_name": "אבי לוי",
  "email": "avi.levi@gmail.com",
  "phone": "+972-54-9876543",
  "current_role": "Product Manager",
  "years_experience": 6,
  "location": "Ramat Gan, Israel",
  "skills": ["product management", "agile", "sql", "b2b saas", "roadmap planning", "stakeholder management"],
  "ai_summary": "Product Manager with 6 years of hands-on experience in B2B SaaS products. Led multiple 0-to-1 product launches and managed cross-functional teams of 10+. Note: ~2 year gap between Operations Lead role (ended 2020) and Product Manager role (started 2022).",
  "source_hint": "agency",
  "source_agency": "jobhunt"
}`;
}

export interface ExtractionMetadata {
  subject: string;
  fromEmail: string;
  tenantId: string;
  messageId: string;
}

@Injectable()
export class ExtractionAgentService {
  private readonly logger = new Logger(ExtractionAgentService.name);
  private readonly openrouter: ReturnType<typeof createOpenRouter>;

  constructor(
    private readonly config: ConfigService,
    private readonly storageService: StorageService,
  ) {
    this.openrouter = createOpenRouter({ apiKey: config.get<string>('OPENROUTER_API_KEY')! });
  }

  async extract(fullText: string, suspicious: boolean, metadata: ExtractionMetadata): Promise<CandidateExtract> {
    // Check R2 cache first — avoid re-calling AI on retry
    const cached = await this.storageService.loadExtractionCache(metadata.tenantId, metadata.messageId);
    if (cached !== null) {
      this.logger.log(`Extraction cache hit for ${metadata.messageId}`);
      const parsed = CandidateExtractSchema.parse(cached);
      return { ...parsed, suspicious };
    }

    const extracted = await this.callAI(fullText, metadata);

    // Cache result to R2 — retries will use this instead of calling AI again
    await this.storageService.saveExtractionCache(extracted, metadata.tenantId, metadata.messageId);

    return { ...extracted, suspicious };
  }

  private async callAI(fullText: string, metadata: ExtractionMetadata): Promise<Omit<CandidateExtract, 'suspicious'>> {
    const MAX_INPUT_LENGTH = 20_000;
    const safeFullText = fullText.substring(0, MAX_INPUT_LENGTH);

    const resolvedAgency = resolveAgencyFromEmail(metadata.fromEmail);

    const metadataLines = [`--- Email Metadata ---`, `Subject: ${metadata.subject}`, `From: ${metadata.fromEmail}`];
    if (resolvedAgency !== null) {
      metadataLines.push(`Resolved Agency Name: ${resolvedAgency}`);
    }

    const prompt = [...metadataLines, ``, `--- CV / Email Content ---`, safeFullText].join('\n');
    const instructions = buildInstructions(new Date().getFullYear());

    const { object } = await generateObject({
      model: this.openrouter.chat('openai/gpt-4o-mini'),
      schema: CandidateExtractSchema,
      schemaName: 'CandidateExtract',
      system: instructions,
      prompt,
      temperature: 0,
    });

    this.logger.log(`OpenRouter extraction successful for ${metadata.messageId}`);

    if (resolvedAgency !== null) {
      return { ...object, source_hint: 'agency', source_agency: resolvedAgency };
    }
    return object;
  }
}
