import { Injectable, Logger } from '@nestjs/common';
import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

export interface JobTitleMatchResult {
  matched: boolean;
  confidence: number; // 0-1 decimal, null if error
  reasoning?: string;
  error?: string;
}

const JobTitleMatchSchema = z.object({
  matched: z.boolean().describe('Whether the two job titles refer to the same role'),
  confidence: z.number().min(0).max(100).describe('Confidence score 0-100'),
  reasoning: z.string().describe('Brief explanation of the match decision'),
});

@Injectable()
export class JobTitleMatcherService {
  private readonly logger = new Logger(JobTitleMatcherService.name);

  async matchJobTitles(
    candidateJobTitle: string,
    positionJobTitle: string,
    tenantId: string
  ): Promise<JobTitleMatchResult> {
    try {
      // Handle empty inputs
      if (!candidateJobTitle?.trim() || !positionJobTitle?.trim()) {
        return {
          matched: false,
          confidence: 0,
        };
      }

      const result = await this.callAI(
        candidateJobTitle,
        positionJobTitle,
        tenantId
      );

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Job title matching failed: ${errorMessage}`,
        {
          candidateJobTitle,
          positionJobTitle,
          tenantId,
        }
      );

      return {
        matched: false,
        confidence: 0,
        error: errorMessage,
      };
    }
  }

  private async callAI(
    candidateJobTitle: string,
    positionJobTitle: string,
    tenantId: string
  ): Promise<JobTitleMatchResult> {
    const { object } = await generateObject({
      model: anthropic('claude-3-5-haiku-20241022'),
      schema: JobTitleMatchSchema,
      prompt: `Given two job titles from the tech industry, determine if they refer to the same role. Consider seniority levels, specializations, and common variations.

Candidate's Job Title: "${candidateJobTitle}"
Position's Job Title: "${positionJobTitle}"

Tenant ID: ${tenantId}

Provide a match decision and confidence score (0-100) where:
- 90-100: Clearly the same role (e.g., "Software Engineer" vs "Senior Software Engineer")
- 70-89: Likely the same role with different wording (e.g., "Frontend Dev" vs "Web Engineer")
- 50-69: Could be same role but with significant variations (rare for clear matches)
- 0-49: Different roles or specializations

Focus on tech industry context. "Product Manager" ≠ "DevOps Engineer" even if both in tech.`,
    });

    // Convert confidence from 0-100 to 0-1 decimal
    const confidenceDecimal = object.confidence / 100;

    return {
      matched: object.matched,
      confidence: Math.min(Math.max(confidenceDecimal, 0), 1), // Clamp to 0-1
      reasoning: object.reasoning,
    };
  }
}
