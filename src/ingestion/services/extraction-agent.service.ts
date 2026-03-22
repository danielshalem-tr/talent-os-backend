import { Injectable } from '@nestjs/common';
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

// System prompt for real Anthropic call (D-02)
// const EXTRACTION_SYSTEM_PROMPT = `You are a CV data extraction assistant.
// Extract structured candidate information from the provided email and CV text.
// Source detection rules:
// - 'agency': email includes recruiter name + agency name + "on behalf of"
// - 'linkedin': subject contains "LinkedIn"
// - 'referral': body mentions "referred by"
// - Default to 'direct'
// Summary format: exactly 2 sentences — sentence 1 is role/experience level, sentence 2 highlights top skills or notable achievement.
// Ambiguous content: still attempt extraction; do not throw.`;

@Injectable()
export class ExtractionAgentService {
  async extract(fullText: string, suspicious: boolean): Promise<CandidateExtract> {
    // TODO: replace mock with real Anthropic call
    // const { object } = await generateObject({
    //   model: anthropic('claude-haiku-4-5'),
    //   schema: CandidateExtractSchema,
    //   system: EXTRACTION_SYSTEM_PROMPT,
    //   prompt: `Extract candidate information from the following email and CV text:\n\n${fullText}`,
    // });
    // return { ...object, suspicious };

    // D-06: deterministic mock — real call activated in follow-up task
    void fullText; // used by real implementation
    return {
      fullName: 'Jane Doe',
      email: 'jane.doe@example.com',
      phone: '+1-555-0100',
      currentRole: 'Senior Software Engineer',
      yearsExperience: 7,
      skills: ['TypeScript', 'Node.js', 'PostgreSQL'],
      summary:
        'Experienced engineer with 7 years building TypeScript backends. Strong in distributed systems and database design.',
      source: 'direct',
      suspicious,
    };
  }
}
