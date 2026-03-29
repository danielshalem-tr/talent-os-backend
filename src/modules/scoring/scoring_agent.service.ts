import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { JobTitleMatcherService } from './job-title-matcher.service';
import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

const ScoringSchema = z.object({
  score: z.number().int().min(0).max(100),
  reasoning: z.string(),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
});

type ScoringResult = z.infer<typeof ScoringSchema>;

const SCORING_INSTRUCTIONS = `You are a technical recruiter evaluating candidate fit for a job opening.
Score the candidate 0-100 against the job requirements.

Return ONLY a raw JSON object with these exact keys:
- "score" (integer 0-100): Overall fit score. 0-30 = poor fit, 31-50 = weak, 51-70 = moderate, 71-85 = strong, 86-100 = exceptional.
- "reasoning" (string): 1-2 sentences explaining the score.
- "strengths" (string[]): 2-5 specific strengths relevant to this job.
- "gaps" (string[]): 0-5 specific gaps or missing requirements.

RULES:
- Base score solely on the provided information — do not assume skills not mentioned.
- If the CV text is very short or uninformative, score conservatively (30-50 range).
- Be specific in strengths and gaps — reference actual skills/requirements, not generic statements.`;

@Injectable()
export class ScoringAgentService {
  private readonly logger = new Logger(ScoringAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobTitleMatcher: JobTitleMatcherService,
    private readonly config: ConfigService,
  ) {}

  async scoreCandidate(candidateId: string, tenantId: string): Promise<void> {
    try {
      // Fetch candidate with all relationships
      const candidate = await this.prisma.candidate.findUnique({
        where: { id: candidateId },
        include: {
          tenant: true,
        },
      });

      if (!candidate) {
        this.logger.warn(`Candidate not found: ${candidateId}`);
        return;
      }

      // Fetch all open jobs for the tenant
      const openJobs = await this.prisma.job.findMany({
        where: {
          tenantId,
          status: 'active',
        },
      });

      if (openJobs.length === 0) {
        this.logger.debug(`No open jobs found for tenant ${tenantId}`);
        return;
      }

      // Score candidate against each job
      for (const job of openJobs) {
        await this.scoreAgainstJob(candidate, job, tenantId);
      }
    } catch (error) {
      this.logger.error(
        `Error scoring candidate ${candidateId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private async scoreAgainstJob(
    candidate: any,
    job: any,
    tenantId: string,
  ): Promise<void> {
    try {
      // Step 1: Check semantic job title match first
      const titleMatch = await this.jobTitleMatcher.matchJobTitles(
        candidate.currentRole || '',
        job.title,
        tenantId,
      );

      if (!titleMatch.matched) {
        this.logger.debug(
          `Job title mismatch: ${candidate.currentRole} vs ${job.title}`,
        );
        return; // Skip Sonnet call entirely
      }

      // Step 2: Check if application exists or create it
      let application = await this.prisma.application.findUnique({
        where: {
          idx_applications_unique: {
            tenantId,
            candidateId: candidate.id,
            jobId: job.id,
          },
        },
      });

      if (!application) {
        application = await this.prisma.application.create({
          data: {
            tenantId,
            candidateId: candidate.id,
            jobId: job.id,
            stage: 'new',
          },
        });
      }

      // Step 3: Score candidate fit for job using Sonnet
      const score = await this.callScoringAI(candidate, job);

      // Step 4: Store score with match_confidence
      await this.prisma.candidateJobScore.create({
        data: {
          tenantId,
          applicationId: application.id,
          score: score.score,
          reasoning: score.reasoning,
          strengths: score.strengths,
          gaps: score.gaps,
          modelUsed: 'claude-3-5-sonnet-20241022',
          matchConfidence: Number(titleMatch.confidence), // Convert Decimal to number for DB
        },
      });

      this.logger.log(
        `Scored candidate ${candidate.id} for job ${job.id}: ${score.score}`,
      );
    } catch (error) {
      this.logger.error(
        `Error scoring candidate against job: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Don't throw — allow pipeline to continue to next job
    }
  }

  private async callScoringAI(candidate: any, job: any): Promise<ScoringResult> {
    const candidateSection = [
      `Candidate:`,
      `- Current Role: ${candidate.currentRole ?? 'Unknown'}`,
      `- Years of Experience: ${candidate.yearsExperience ?? 'Unknown'}`,
      `- Skills: ${candidate.skills.length > 0 ? candidate.skills.join(', ') : 'None listed'}`,
      ``,
      `CV Text:`,
      candidate.cvText || 'No CV text provided',
    ].join('\n');

    const jobSection = [
      `Job:`,
      `- Title: ${job.title}`,
      `- Description: ${job.description ?? 'N/A'}`,
      `- Requirements: ${job.requirements.length > 0 ? job.requirements.join(', ') : 'None specified'}`,
    ].join('\n');

    const userMessage = `${candidateSection}\n\n${jobSection}`;

    const { object } = await generateObject({
      model: anthropic('claude-3-5-sonnet-20241022'),
      schema: ScoringSchema,
      prompt: SCORING_INSTRUCTIONS + '\n\n' + userMessage,
    });

    return object;
  }
}
