import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenRouter } from '@openrouter/sdk';
import { z } from 'zod';

export const CandidateExtractSchema = z.object({
  full_name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  skills: z.array(z.string()),
  ai_summary: z.string().nullable(),
});

export type CandidateExtract = z.infer<typeof CandidateExtractSchema> & {
  suspicious: boolean;
};

const FALLBACK: Omit<CandidateExtract, 'suspicious'> = {
  full_name: '',
  email: null,
  phone: null,
  skills: [],
  ai_summary: null,
};

const INSTRUCTIONS = `You are a CV data extraction assistant.
Extract candidate information from the provided CV text and return ONLY a raw JSON object — no markdown, no code fences, no explanation.
The JSON must contain exactly these keys:
- full_name: candidate's full name (string)
- email: candidate's email address (string or null)
- phone: candidate's phone number (string or null)
- skills: list of technical and professional skills (array of strings)
- ai_summary: exactly 2 sentences — sentence 1 is role/experience level, sentence 2 highlights top skills or a notable achievement (string or null)
If a field cannot be determined, use null. Do not add any other keys.`;

@Injectable()
export class ExtractionAgentService {
  private readonly logger = new Logger(ExtractionAgentService.name);

  constructor(private readonly config: ConfigService) {}

  async extract(fullText: string, suspicious: boolean): Promise<CandidateExtract> {
    try {
      const extracted = await this.callAI(fullText);
      return { ...extracted, suspicious };
    } catch (err) {
      this.logger.error('OpenRouter extraction failed — returning safe fallback.', err);
      return { ...FALLBACK, suspicious };
    }
  }

  // AI_PROVIDER: swap this method to change provider (e.g. @ai-sdk/anthropic generateObject)
  // Current: @openrouter/sdk — google/gemini-2.0-flash:free
  private async callAI(fullText: string): Promise<Omit<CandidateExtract, 'suspicious'>> {
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY')!;
    const client = new OpenRouter({ apiKey });

    const result = client.callModel({
      model: 'google/gemini-2.0-flash:free',
      instructions: INSTRUCTIONS,
      input: `Extract candidate information from the following text:\n\n${fullText}`,
    });

    const raw = await result.getText();

    // Strip markdown code fences if the model ignores instructions
    const json = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const parsed = CandidateExtractSchema.parse(JSON.parse(json));
    this.logger.log('OpenRouter extraction successful', parsed);
    return parsed;
  }

  private extractDeterministically(fullText: string): Omit<CandidateExtract, 'suspicious'> {
    const lines = fullText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // 1. Full Name: first line (best guess)
    const fullName = lines[0] || '';

    // 2. Email: simple regex
    const emailMatch = fullText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch ? emailMatch[0] : null;

    // 3. Phone: simple regex (supports + and numbers/dashes, flexible for international/Israeli formats)
    const phoneMatch = fullText.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,3}\)?[-.\s]?\d{2,4}[-.\s]?\d{4}/);
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
    const skills = commonSkills.filter((skill) => new RegExp(`\\b${skill}\\b`, 'i').test(fullText));

    return {
      full_name: fullName,
      email,
      phone,
      skills,
      ai_summary: `Deterministic extraction: Found ${skills.length} skills. Name: ${fullName}`,
    };
  }
}
