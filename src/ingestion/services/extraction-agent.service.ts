import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenRouter } from '@openrouter/sdk';
import { z } from 'zod';

export const CandidateExtractSchema = z.object({
  full_name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  current_role: z.string().nullable(),
  years_experience: z.number().int().min(0).max(50).nullable(),
  location: z.string().nullable(),
  job_title_hint: z.string().nullable(),
  skills: z.array(z.string()),
  ai_summary: z.string().nullable(),
  source_hint: z.enum(['linkedin', 'agency', 'referral', 'direct']).nullable(),
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
  job_title_hint: null,
  skills: [],
  ai_summary: null,
  source_hint: null,
};

const INSTRUCTIONS = `You are a CV data extraction assistant.
Extract candidate information from the provided email metadata and CV text. Return ONLY a raw JSON object — no markdown, no code fences, no explanation.
The JSON must contain exactly these keys:
- full_name: candidate's full name (string, required — use empty string "" if truly unknown)
- email: candidate's email address (string or null)
- phone: candidate's phone number in international format (string or null)
- current_role: candidate's current or most recent job title (string or null)
- years_experience: total years of professional experience as a SINGLE INTEGER — convert ranges like "5-7 years" to the midpoint (integer or null)
- location: candidate's location as "City, Country" format (string or null)
- job_title_hint: inferred job title or role the candidate would be a good fit for, based on CV content (string or null) — e.g., if CV shows Node.js/TypeScript expertise, extract "Backend Developer" or "Full Stack Developer"
- skills: list of technical and professional skills — 5 to 15 short tags, lowercase preferred (array of strings)
- ai_summary: exactly 2 sentences — sentence 1 is role/experience level, sentence 2 highlights top skills or a notable achievement (string or null)
- source_hint: how this CV was received — use email metadata to infer: "linkedin" if subject/from mentions LinkedIn or Recruiter; "agency" if from a recruiting agency domain or subject says "presenting candidate"; "referral" if body mentions referred by someone; "direct" if sent directly by the candidate; null if unclear

Use the From and Subject fields as signals for source_hint detection. If a field cannot be determined, use null.

Example output:
{
  "full_name": "Dana Cohen",
  "email": "dana.cohen@gmail.com",
  "phone": "+972-52-1234567",
  "current_role": "Senior Backend Developer",
  "years_experience": 6,
  "location": "Tel Aviv, Israel",
  "job_title_hint": "Senior Backend Developer",
  "skills": ["node.js", "typescript", "postgresql", "docker", "aws", "system design"],
  "ai_summary": "Senior Backend Developer with 6 years of experience in server-side development. Specializes in Node.js and cloud infrastructure with a track record of leading microservices migrations.",
  "source_hint": "direct"
}`;

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

    const userMessage = [
      `--- Email Metadata ---`,
      `Subject: ${metadata.subject}`,
      `From: ${metadata.fromEmail}`,
      ``,
      `--- CV / Email Content ---`,
      fullText,
    ].join('\n');

    const result = client.callModel({
      model: 'openai/gpt-4o-mini',
      instructions: INSTRUCTIONS,
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
    return parseResult.data;
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
        !line.startsWith('From:'),
    );
    const realText = realLines.join('\n');

    // 1. Full Name: first real line (best guess)
    const fullName = realLines[0] || '';

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
      current_role: null,        // deterministic cannot infer role
      years_experience: null,    // deterministic cannot infer years
      location: null,            // deterministic cannot infer location
      job_title_hint: null,      // deterministic cannot infer job title hint
      skills,
      ai_summary: `Deterministic extraction: Found ${skills.length} skills. Name: ${fullName}`,
      source_hint: null,         // deterministic cannot infer source
    };
  }

  // FALLBACK is kept for potential use in processor deterministic fallback paths
  getFallback(): Omit<CandidateExtract, 'suspicious'> {
    return { ...FALLBACK };
  }
}
