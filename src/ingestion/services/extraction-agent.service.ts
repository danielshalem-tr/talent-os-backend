import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenRouter } from '@openrouter/sdk';
import { z } from 'zod';

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

const FALLBACK: Omit<CandidateExtract, 'suspicious'> = {
  full_name: '',
  email: null,
  phone: null,
  current_role: null,
  years_experience: null,
  location: null,
  skills: [],
  ai_summary: null,
  source_hint: null,
  source_agency: null,
};

/**
 * Known agency domain → canonical name map.
 * Deterministic resolution — never rely on AI for these.
 * Keys are lowercase domain strings (without port).
 */
const KNOWN_AGENCY_DOMAINS: Record<string, string> = {
  'jobhunt.co.il': 'jobhunt',
  'alljob.co.il': 'allJobs',
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

@Injectable()
export class ExtractionAgentService {
  private readonly logger = new Logger(ExtractionAgentService.name);

  constructor(private readonly config: ConfigService) {}

  async extract(
    fullText: string,
    suspicious: boolean,
    metadata: { subject: string; fromEmail: string },
  ): Promise<CandidateExtract> {
    const extracted = await this.callAI(fullText, metadata);
    return { ...extracted, suspicious };
  }

  // AI_PROVIDER: swap this method to change provider (e.g. @ai-sdk/anthropic generateObject)
  // Current: @openrouter/sdk — openai/gpt-4o-mini
  private async callAI(
    fullText: string,
    metadata: { subject: string; fromEmail: string },
  ): Promise<Omit<CandidateExtract, 'suspicious'>> {
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY')!;
    const client = new OpenRouter({ apiKey });

    const MAX_INPUT_LENGTH = 20_000;
    const safeFullText = fullText.substring(0, MAX_INPUT_LENGTH);

    // Issue 3 fix: deterministically resolve agency name from known sender domains
    // before calling AI — avoids non-deterministic AI agency name inference.
    const resolvedAgency = resolveAgencyFromEmail(metadata.fromEmail);

    const metadataLines = [`--- Email Metadata ---`, `Subject: ${metadata.subject}`, `From: ${metadata.fromEmail}`];
    if (resolvedAgency !== null) {
      metadataLines.push(`Resolved Agency Name: ${resolvedAgency}`);
    }

    const userMessage = [...metadataLines, ``, `--- CV / Email Content ---`, safeFullText].join('\n');

    // Build instructions with current year injected dynamically (avoids stale year on long-running processes)
    const instructions = buildInstructions(new Date().getFullYear());

    try {
      const result = client.callModel({
        model: 'openai/gpt-4o-mini',
        instructions,
        input: userMessage,
      });

      const raw = await result.getText();

      // Strip markdown code fences if the model ignores instructions
      const json = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();

      const parseResult = CandidateExtractSchema.safeParse(JSON.parse(json));
      if (!parseResult.success) {
        this.logger.error('LLM returned invalid JSON structure', parseResult.error.issues);
        throw new Error(`LLM output validation failed: ${parseResult.error.message}`);
      }
      this.logger.log('OpenRouter extraction successful', parseResult.data);

      // Issue 3 fix: post-processing override — if we resolved the agency deterministically,
      // force source_agency to the canonical name regardless of what the AI returned.
      const data = parseResult.data;
      if (resolvedAgency !== null) {
        return { ...data, source_hint: 'agency', source_agency: resolvedAgency };
      }
      return data;
    } catch (error) {
      if (error instanceof Error && (error.message.includes('400') || error.message.includes('413'))) {
        this.logger.error(`LLM context window exceeded: ${error.message}`);
        throw new Error('EXTRACTION_CONTEXT_EXCEEDED');
      }
      throw error;
    }
  }

  extractDeterministically(fullText: string): Omit<CandidateExtract, 'suspicious'> {
    const lines = fullText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // Skip injected headers like "--- Email Body ---" or "--- Attachment ---"
    const realLines = lines.filter(
      (line) =>
        !line.startsWith('--- Email Body ---') &&
        !line.startsWith('--- Attachment') &&
        !line.startsWith('--- Email Metadata ---') &&
        !line.startsWith('Subject:') &&
        !line.startsWith('From:') &&
        !/^(Curriculum Vitae|Professional Summary|CONFIDENTIAL|Private & Confidential|Resume|CV)\b/i.test(line),
    );
    const realText = realLines.join('\n');

    /**
     * Heuristic: a line "looks like a name" if it has 2-5 short words,
     * contains at least one Unicode letter, and doesn't look like a date,
     * year, greeting, or sentence.
     * Supports Latin ("John Doe"), Hebrew ("אבי לוי"), Arabic ("محمد علي"),
     * hyphenated names ("Jean-Pierre Dupont"), and multi-part names ("Maria de la Cruz").
     */
    const looksLikeName = (line: string): boolean => {
      const trimmed = line.trim();
      const words = trimmed.split(/\s+/);

      if (
        trimmed.length < 3 ||
        trimmed.length > 80 ||
        /^\d{1,2}[/.-]\d{1,2}/.test(trimmed) || // date patterns: 01/15, 15-01
        /\d{4}/.test(trimmed) || // contains a year
        /^(dear|hello|hi|to|from|subject|re:|tel:|phone:|email:)/i.test(trimmed) ||
        words.length < 2 || // single word: "Summary", "Jerusalem"
        words.length > 5 // 6+ words = likely a sentence
      ) {
        return false;
      }

      return /\p{L}/u.test(trimmed);
    };

    // 1. Full Name: first line that looks like a name (best guess)
    const fullName = realLines.find((line) => looksLikeName(line)) || 'Unknown Candidate';

    // 2. Email: simple regex
    const emailMatch = realText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch ? emailMatch[0] : null;

    // 3. Phone: simple regex (supports + and numbers/dashes, flexible for international/Israeli formats)
    const phoneMatch = realText.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,3}\)?[-.\s]?\d{2,4}[-.\s]?\d{4}/);
    const phone = phoneMatch ? phoneMatch[0] : null;

    // 4. Skills: keyword matching (example set)
    const commonSkills = [
      'javascript',
      'typescript',
      'nest',
      'react',
      'node',
      'python',
      'java',
      'sql',
      'docker',
      'aws',
      'kubernetes',
      'html',
      'css',
      'git',
    ];
    const skills = commonSkills.filter((skill) => new RegExp(`\\b${skill}\\b`, 'i').test(realText));

    return {
      full_name: fullName,
      email,
      phone,
      current_role: null, // deterministic cannot infer role
      years_experience: null, // deterministic cannot infer years
      location: null, // deterministic cannot infer location
      skills,
      ai_summary: `Deterministic extraction: Found ${skills.length} skills. Name: ${fullName}`,
      source_hint: null, // deterministic cannot infer source
      source_agency: null, // deterministic cannot infer agency
    };
  }

  // FALLBACK is kept for potential use in processor deterministic fallback paths
  getFallback(): Omit<CandidateExtract, 'suspicious'> {
    return { ...FALLBACK };
  }
}
