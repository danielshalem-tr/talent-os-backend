import 'multer';
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CreateCandidateDto } from './dto/create-candidate.dto';
import { UpdateCandidateStageDto } from './dto/update-candidate-stage.dto';
import { UpdateCandidateDto } from './dto/update-candidate.dto';
import { StageSummaryDto } from './dto/stage-summary.dto';
import { RejectCandidateDto } from './dto/reject-candidate.dto';
import { CandidateResponse, computeCvReadable } from './dto/candidate-response.dto';
import { Candidate, Prisma } from '@prisma/client';
import { CandidateAiService } from './candidate-ai.service';
import { ScoringAgentService } from '../scoring/scoring.service';
import { scoringJobSelect, toScoringJob, ScoringJobRow } from '../scoring/scoring-job-context';
import { AttachmentExtractorService } from '../ingestion/services/attachment-extractor.service';
import { sanitizePgText } from '../common/sanitize-pg-text';
import { moveCandidateToStage } from './stage-move';
import type { EmailAttachmentDto } from '../webhooks';

export type CandidateFilter = 'all';

@Injectable()
export class CandidatesService {
  private readonly logger = new Logger(CandidatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly candidateAiService: CandidateAiService,
    private readonly scoringAgent: ScoringAgentService,
    private readonly attachmentExtractor: AttachmentExtractorService,
  ) {}

  async getCounts(tenantId: string): Promise<{ total: number; duplicates: number; unassigned: number }> {
    const [total, unassigned] = await Promise.all([
      this.prisma.candidate.count({ where: { tenantId, status: 'active' } }),
      this.prisma.candidate.count({ where: { tenantId, status: 'active', jobId: null } }),
    ]);
    // Duplicate flags are no longer produced or read (dedup auto-merges). Kept at 0 until the
    // client stops reading it; the counts shape changes in the Pool/Archive round.
    return { total, duplicates: 0, unassigned };
  }

  async findAll(
    tenantId: string,
    q?: string,
    filter?: CandidateFilter,
    jobId?: string,
    unassigned?: boolean,
    createdWithinDays?: string,
  ): Promise<{ candidates: CandidateResponse[]; total: number }> {
    // Only 'all' remains. 'duplicates' was removed with the duplicate-flag pipeline; reject it
    // loudly rather than silently returning everything.
    if (filter && filter !== 'all') {
      throw new BadRequestException({
        error: { code: 'INVALID_FILTER', message: `Filter '${filter}' is not supported. Use 'all'.` },
      });
    }

    // Build WHERE conditions
    const where: Prisma.CandidateWhereInput = { tenantId };

    // ── filter by job ──────────────────────────────────────────────
    if (unassigned) {
      where.jobId = null;
    } else if (jobId) {
      where.jobId = jobId;
    }

    // Always use positive match for better index friendliness
    where.status = 'active';

    // ── filter by entry date ───────────────────────────────────────
    // Raw query string in, validated here: the talent pool sends 7 / 14 / 30.
    if (createdWithinDays !== undefined && createdWithinDays !== '') {
      const days = Number(createdWithinDays);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new BadRequestException({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'created_within_days must be an integer between 1 and 3650',
          },
        });
      }
      where.createdAt = { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
    }

    if (q) {
      where.OR = [
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { currentRole: { contains: q, mode: 'insensitive' } },
      ];
    }

    const candidates = await this.prisma.candidate.findMany({
      where,
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        currentRole: true,
        location: true,
        cvFileUrl: true,
        source: true,
        sourceAgency: true,
        yearsExperience: true,
        salaryExpectationMin: true,
        salaryExpectationMax: true,
        aiSummary: true,
        aiScore: true,
        cvText: true,
        isScoreOverridden: true,
        createdAt: true,
        skills: true,
        jobId: true,
        hiringStageId: true,
        hiringStage: {
          select: { name: true },
        },
        job: {
          select: { title: true },
        },
        status: true,
        rejectionReason: true,
        rejectionNote: true,
        candidateStageSummaries: {
          select: { jobStageId: true, summary: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Compute derived fields and map to snake_case
    let result: CandidateResponse[] = candidates.map((c) => {
      const aiScore = c.aiScore;

      return {
        id: c.id,
        full_name: c.fullName,
        email: c.email,
        phone: c.phone,
        current_role: c.currentRole,
        location: c.location,
        cv_file_url: c.cvFileUrl,
        years_experience: c.yearsExperience,
        salary_expectation_min: c.salaryExpectationMin,
        salary_expectation_max: c.salaryExpectationMax,
        ai_summary: c.aiSummary,
        source: c.source,
        source_agency: c.sourceAgency,
        created_at: c.createdAt,
        ai_score: aiScore,
        cv_readable: computeCvReadable(c.cvText),
        is_score_overridden: c.isScoreOverridden,
        is_duplicate: false, // deprecated — always false since Round 1 dedup; removed in Round 2
        skills: c.skills,

        // Profile data
        status: c.status,
        is_rejected: c.status === 'rejected',
        rejection_reason: c.rejectionReason ?? null,
        rejection_note: c.rejectionNote ?? null,
        stage_summaries: c.candidateStageSummaries.reduce(
          (acc, curr) => {
            acc[curr.jobStageId] = curr.summary;
            return acc;
          },
          {} as Record<string, string>,
        ),

        // Kanban board fields
        job_id: c.jobId,
        hiring_stage_id: c.hiringStageId,
        hiring_stage_name: c.hiringStage?.name ?? null,
        job_title: c.job?.title ?? null,
        // The list endpoint does not join voice calls — one extra join per row isn't worth
        // it; the profile page reads latest_call from GET /candidates/:id.
        latest_call: null,
        score_details: null,
      };
    });

    return { candidates: result, total: result.length };
  }

  async findOne(candidateId: string, tenantId: string): Promise<CandidateResponse> {
    const c = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        currentRole: true,
        location: true,
        cvFileUrl: true,
        source: true,
        sourceAgency: true,
        createdAt: true,
        skills: true,
        jobId: true,
        hiringStageId: true,
        yearsExperience: true,
        salaryExpectationMin: true,
        salaryExpectationMax: true,
        aiSummary: true,
        aiScore: true,
        cvText: true,
        isScoreOverridden: true,
        hiringStage: {
          select: { name: true },
        },
        job: {
          select: { title: true },
        },
        applications: {
          select: {
            jobId: true,
            scores: {
              select: {
                score: true,
                reasoning: true,
                strengths: true,
                gaps: true,
                modelUsed: true,
                scoredAt: true,
                breakdown: true,
              },
            },
          },
        },
        status: true,
        rejectionReason: true,
        rejectionNote: true,
        candidateStageSummaries: {
          select: { jobStageId: true, summary: true },
        },
        voiceCalls: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true, attempt: true, scheduledFor: true, summary: true },
        },
      },
    });

    if (!c) {
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'Candidate not found' },
      });
    }

    const latestCall = c.voiceCalls?.[0] ?? null;
    // The score shown on the profile is the one for the job the candidate is currently on —
    // a candidate can carry applications (and scores) for jobs they were moved off.
    const assignedScore = c.jobId ? (c.applications?.find((a) => a.jobId === c.jobId)?.scores?.[0] ?? null) : null;

    return {
      id: c.id,
      full_name: c.fullName,
      email: c.email,
      phone: c.phone,
      current_role: c.currentRole,
      location: c.location,
      cv_file_url: c.cvFileUrl,
      source: c.source,
      source_agency: c.sourceAgency,
      created_at: c.createdAt,
      ai_score: c.aiScore,
      cv_readable: computeCvReadable(c.cvText),
      is_score_overridden: c.isScoreOverridden,
      ai_summary: c.aiSummary,
      is_duplicate: false, // deprecated — always false since Round 1 dedup; removed in Round 2
      years_experience: c.yearsExperience,
      salary_expectation_min: c.salaryExpectationMin,
      salary_expectation_max: c.salaryExpectationMax,
      skills: c.skills,
      status: c.status,
      is_rejected: c.status === 'rejected',
      rejection_reason: c.rejectionReason ?? null,
      rejection_note: c.rejectionNote ?? null,
      stage_summaries: c.candidateStageSummaries.reduce(
        (acc, curr) => {
          acc[curr.jobStageId] = curr.summary;
          return acc;
        },
        {} as Record<string, string>,
      ),
      job_id: c.jobId,
      hiring_stage_id: c.hiringStageId,
      hiring_stage_name: c.hiringStage?.name ?? null,
      job_title: c.job?.title ?? null,
      // Optional-chained: the select above always returns the array, but several service
      // unit tests stub findFirst with fixtures that predate this join.
      latest_call: latestCall
        ? {
            id: latestCall.id,
            status: latestCall.status,
            attempt: latestCall.attempt,
            scheduled_for: latestCall.scheduledFor?.toISOString() ?? null,
            summary: latestCall.summary,
          }
        : null,
      score_details: assignedScore
        ? {
            score: assignedScore.score,
            reasoning: assignedScore.reasoning,
            strengths: assignedScore.strengths,
            gaps: assignedScore.gaps,
            model_used: assignedScore.modelUsed,
            scored_at: assignedScore.scoredAt.toISOString(),
            breakdown: assignedScore.breakdown ?? null,
          }
        : null,
    };
  }

  /**
   * Score a candidate against the job they were just attached to.
   *
   * Shared by both assignment branches of {@link updateCandidate} — a first assignment and a
   * reassignment must leave the candidate in the same state, and keeping one copy is what stops
   * them drifting apart again (they did: the initial branch shipped without scoring at all).
   *
   * MUST be called AFTER the assignment transaction has committed, never inside it. `score()` is
   * an LLM round-trip; Prisma's interactive transactions time out at 5s by default, so scoring
   * inside one rolls the whole assignment back and holds a candidate row lock plus a pool
   * connection for the duration. Every other scoring path here (ingestion, bulk assign, manual
   * rescore) writes outside a transaction for the same reason.
   *
   * Non-blocking per D-21: a scoring failure is logged and swallowed — the assignment stands.
   */
  private async scoreNewAssignment(args: {
    candidateId: string;
    tenantId: string;
    jobId: string;
    candidate: Pick<Candidate, 'cvText' | 'currentRole' | 'yearsExperience' | 'skills'>;
    dto: UpdateCandidateDto;
    job: ScoringJobRow;
  }): Promise<void> {
    const { candidateId, tenantId, jobId, candidate, dto, job } = args;

    // No CV means nothing to score against. The scorer would still answer — it is told to score
    // "conservatively" on thin input — and that invented number is worse than an empty score.
    // assignCandidateToJob makes the same call (outcome: 'assigned_not_scored').
    const cvText = candidate.cvText?.trim() ?? '';
    if (cvText === '') return;

    try {
      const scoreResult = await this.scoringAgent.score({
        cvText,
        candidateFields: {
          currentRole: dto.current_role ?? candidate.currentRole,
          yearsExperience: dto.years_experience ?? candidate.yearsExperience,
          skills: candidate.skills,
        },
        job: toScoringJob(job),
      });

      // The application the transaction just created/moved is what the score hangs off.
      const application = await this.prisma.application.findFirst({
        where: { candidateId, jobId, tenantId },
        select: { id: true },
      });
      if (!application) return;

      // upsert, not create: re-assigning to the same job must overwrite rather than trip the
      // unique index — a swallowed P2002 here would look exactly like the unscored bug.
      const scoreFields = {
        score: scoreResult.score,
        reasoning: scoreResult.reasoning,
        strengths: scoreResult.strengths,
        gaps: scoreResult.gaps,
        breakdown: scoreResult.breakdown as unknown as Prisma.InputJsonValue,
        modelUsed: scoreResult.modelUsed,
      };
      await this.prisma.candidateJobScore.upsert({
        where: { idx_scores_unique_per_app: { tenantId, applicationId: application.id } },
        create: { tenantId, applicationId: application.id, ...scoreFields },
        update: scoreFields,
      });

      // Denormalized aiScore — skipped while a recruiter override is sticky (TO-58).
      // updateMany makes the guard atomic (no separate read).
      await this.prisma.candidate.updateMany({
        where: { id: candidateId, isScoreOverridden: false },
        data: { aiScore: scoreResult.score },
      });
    } catch (err) {
      this.logger.warn(`Scoring failed during job assignment for candidate ${candidateId}: ${err.message}`);
      // Continue — do not block the assignment
    }
  }

  async updateCandidate(candidateId: string, dto: UpdateCandidateDto, tenantId: string): Promise<CandidateResponse> {
    const candidate = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
    });

    if (!candidate) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Candidate not found' } });

    // Handle string updates separately
    const updateData: Prisma.CandidateUncheckedUpdateInput = {};
    if (dto.full_name !== undefined) updateData.fullName = dto.full_name;
    if (dto.email !== undefined) updateData.email = dto.email;
    if (dto.phone !== undefined) updateData.phone = dto.phone;
    if (dto.current_role !== undefined) updateData.currentRole = dto.current_role;
    if (dto.location !== undefined) updateData.location = dto.location;
    if (dto.years_experience !== undefined) updateData.yearsExperience = dto.years_experience;
    if (dto.salary_expectation_min !== undefined) updateData.salaryExpectationMin = dto.salary_expectation_min;
    if (dto.salary_expectation_max !== undefined) updateData.salaryExpectationMax = dto.salary_expectation_max;
    if (dto.ai_score !== undefined) {
      updateData.aiScore = dto.ai_score;
      updateData.isScoreOverridden = true;
    }

    // Handle atomic job assignment flow
    if (dto.job_id) {
      if (candidate.jobId === dto.job_id) {
        // Same-job no-op: if no profile fields changed, return early
        if (Object.keys(updateData).length === 0) return this.findOne(candidateId, tenantId);
      } else if (candidate.jobId) {
        // REASSIGNMENT: jobId=X → jobId=Y
        const firstStage = await this.prisma.jobStage.findFirst({
          where: { jobId: dto.job_id, tenantId, isEnabled: true },
          orderBy: { order: 'asc' },
          select: { id: true },
        });

        if (!firstStage) {
          throw new BadRequestException({ error: { code: 'NO_STAGES', message: 'Job has no enabled stages' } });
        }

        const job = await this.prisma.job.findFirst({
          where: { id: dto.job_id, tenantId },
          select: { id: true, ...scoringJobSelect },
        });

        if (!job) {
          throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Job not found' } });
        }

        await this.prisma.$transaction(async (tx) => {
          // 1. Application row. upsert, not create: ingestion writes an Application for EVERY
          //    matched job while candidate.jobId names only the primary one, so the row for the
          //    target job often already exists. create() would trip idx_applications_unique and
          //    fail the whole assignment with a 500.
          //    Unlike assignCandidateToJob (which preserves an existing stage so voice
          //    auto-advance wins), this path rewrites jobStageId: step 2 below resets
          //    candidate.hiringStageId unconditionally, and the kanban (which reads the
          //    candidate) must not disagree with voice assess (which reads the application).
          await tx.application.upsert({
            where: { idx_applications_unique: { tenantId, candidateId, jobId: dto.job_id! } },
            create: {
              tenantId,
              candidateId,
              jobId: dto.job_id!,
              stage: 'new',
              jobStageId: firstStage.id,
            },
            update: { jobStageId: firstStage.id },
          });

          // 2. Update Candidate
          await tx.candidate.update({
            where: { id: candidateId },
            data: {
              ...updateData,
              jobId: dto.job_id,
              hiringStageId: firstStage.id,
            },
          });
        });

        // 3. Score — outside the transaction, see scoreNewAssignment.
        await this.scoreNewAssignment({ candidateId, tenantId, jobId: dto.job_id, candidate, dto, job });

        return this.findOne(candidateId, tenantId);
      } else {
        // INITIAL ASSIGNMENT: jobId=null → jobId=X
        const firstStage = await this.prisma.jobStage.findFirst({
          where: { jobId: dto.job_id, tenantId, isEnabled: true },
          orderBy: { order: 'asc' },
          select: { id: true },
        });

        if (!firstStage) {
          throw new BadRequestException({ error: { code: 'NO_STAGES', message: 'Job has no enabled stages' } });
        }

        const job = await this.prisma.job.findFirst({
          where: { id: dto.job_id, tenantId },
          select: { id: true, ...scoringJobSelect },
        });

        let newAiSummary = candidate.aiSummary;
        if (!newAiSummary && job) {
          newAiSummary = await this.candidateAiService.generateSummary({
            fullName: dto.full_name ?? candidate.fullName,
            currentRole: dto.current_role ?? candidate.currentRole,
            yearsExperience: dto.years_experience ?? candidate.yearsExperience,
            skills: candidate.skills,
            cvText: candidate.cvText,
            jobTitle: job.title,
          });
        }

        if (newAiSummary && newAiSummary !== candidate.aiSummary) {
          updateData.aiSummary = newAiSummary;
        }

        await this.prisma.$transaction(async (tx) => {
          // 1. Mapping application — upsert for the same reason as the reassignment branch above.
          await tx.application.upsert({
            where: { idx_applications_unique: { tenantId, candidateId, jobId: dto.job_id! } },
            create: {
              tenantId,
              candidateId,
              jobId: dto.job_id!,
              stage: 'new',
              jobStageId: firstStage.id,
            },
            update: { jobStageId: firstStage.id },
          });
          // 2. Update candidate tracking fields explicitly setting stage to satisfy integrity constraint
          await tx.candidate.update({
            where: { id: candidateId },
            data: {
              ...updateData,
              jobId: dto.job_id,
              hiringStageId: firstStage.id,
            },
          });
        });

        // 3. Score — outside the transaction, see scoreNewAssignment. A first assignment must
        // land in the pipeline scored exactly like a reassignment does; without this the
        // candidate sits at ai_score: null until someone triggers a manual rescore.
        if (job) {
          await this.scoreNewAssignment({ candidateId, tenantId, jobId: dto.job_id, candidate, dto, job });
        }

        return this.findOne(candidateId, tenantId); // Early return post transaction
      }
    }

    // Standard fallback update if no job_id was newly assigned
    if (Object.keys(updateData).length > 0) {
      await this.prisma.candidate.update({
        where: { id: candidateId },
        data: updateData,
      });
    }

    return this.findOne(candidateId, tenantId);
  }

  async rejectCandidate(candidateId: string, dto: RejectCandidateDto, tenantId: string): Promise<CandidateResponse> {
    const candidate = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: { id: true, jobId: true },
    });

    if (!candidate) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Candidate not found' } });

    await this.prisma.$transaction(async (tx) => {
      await tx.candidate.update({
        where: { id: candidateId },
        data: { status: 'rejected', rejectionReason: dto.reason, rejectionNote: dto.note ?? null },
      });

      if (candidate.jobId) {
        await tx.application.updateMany({
          where: { candidateId, jobId: candidate.jobId, tenantId },
          data: { stage: 'rejected' },
        });
      }
    });

    return this.findOne(candidateId, tenantId);
  }

  /**
   * Re-scores a candidate against its assigned job and writes the denormalized
   * aiScore. Callers MUST ensure the candidate has a jobId and non-blank cvText.
   * Reuses the reassignment scoring shape (ScoringAgentService + CandidateJobScore).
   */
  private async rescoreAssignedJob(
    candidate: {
      id: string;
      jobId: string;
      cvText: string | null;
      currentRole: string | null;
      yearsExperience: number | null;
      skills: string[];
    },
    tenantId: string,
  ): Promise<{ score: number; reasoning: string; strengths: string[]; gaps: string[]; modelUsed: string } | null> {
    const job = await this.prisma.job.findFirst({
      where: { id: candidate.jobId, tenantId },
      select: { id: true, ...scoringJobSelect },
    });
    if (!job) {
      await this.prisma.candidate.update({ where: { id: candidate.id }, data: { aiScore: null } });
      return null;
    }

    const scoreResult = await this.scoringAgent.score({
      cvText: candidate.cvText || '',
      candidateFields: {
        currentRole: candidate.currentRole,
        yearsExperience: candidate.yearsExperience,
        skills: candidate.skills,
      },
      job: toScoringJob(job),
    });

    const application = await this.prisma.application.findFirst({
      where: { candidateId: candidate.id, jobId: candidate.jobId, tenantId },
      select: { id: true },
    });

    if (application) {
      await this.prisma.candidateJobScore.upsert({
        where: { idx_scores_unique_per_app: { tenantId, applicationId: application.id } },
        create: {
          tenantId,
          applicationId: application.id,
          score: scoreResult.score,
          reasoning: scoreResult.reasoning,
          strengths: scoreResult.strengths,
          gaps: scoreResult.gaps,
          breakdown: scoreResult.breakdown as unknown as Prisma.InputJsonValue,
          modelUsed: scoreResult.modelUsed,
        },
        update: {
          score: scoreResult.score,
          reasoning: scoreResult.reasoning,
          strengths: scoreResult.strengths,
          gaps: scoreResult.gaps,
          breakdown: scoreResult.breakdown as unknown as Prisma.InputJsonValue,
          modelUsed: scoreResult.modelUsed,
        },
      });
    }

    await this.prisma.candidate.updateMany({
      where: { id: candidate.id, isScoreOverridden: false },
      data: { aiScore: scoreResult.score },
    });

    return scoreResult;
  }

  /**
   * MCP: re-score a candidate against its currently-assigned job, inline, and
   * return the fresh score. Reuses the reassignment scoring path. Returns null
   * when there is no assigned job or the CV text is blank.
   */
  async rescoreCandidate(
    candidateId: string,
    tenantId: string,
  ): Promise<{ score: number; reasoning: string; strengths: string[]; gaps: string[]; modelUsed: string } | null> {
    const candidate = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: { id: true, jobId: true, cvText: true, currentRole: true, yearsExperience: true, skills: true },
    });
    if (!candidate) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Candidate not found' } });
    }
    if (!candidate.jobId || !candidate.cvText || candidate.cvText.trim() === '') {
      return null;
    }
    return this.rescoreAssignedJob({ ...candidate, jobId: candidate.jobId }, tenantId);
  }

  /**
   * TO-58: clear a manual override and return to an AI score. Re-scores the
   * assigned job immediately; if no job or no CV text, aiScore becomes null.
   */
  async revertScore(candidateId: string, tenantId: string): Promise<CandidateResponse> {
    const candidate = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: {
        id: true,
        jobId: true,
        cvText: true,
        currentRole: true,
        yearsExperience: true,
        skills: true,
      },
    });
    if (!candidate) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Candidate not found' } });
    }

    if (candidate.jobId && candidate.cvText && candidate.cvText.trim() !== '') {
      // Clear the sticky flag first so re-scoring writes are allowed again.
      await this.prisma.candidate.update({
        where: { id: candidateId },
        data: { isScoreOverridden: false },
      });
      await this.rescoreAssignedJob({ ...candidate, jobId: candidate.jobId }, tenantId);
    } else {
      // No job or no CV text: single atomic write clears the flag and nulls the score.
      await this.prisma.candidate.update({
        where: { id: candidateId },
        data: { isScoreOverridden: false, aiScore: null },
      });
    }

    return this.findOne(candidateId, tenantId);
  }

  /**
   * TO-56: upload a CV, re-extract text, regenerate the AI summary, and (when a
   * job is assigned and the score is not overridden) re-score the assigned job.
   * Synchronous — mirrors the manual-create flow.
   */
  async uploadCv(candidateId: string, file: Express.Multer.File, tenantId: string): Promise<CandidateResponse> {
    const MAX_BYTES = 10 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      throw new BadRequestException({ error: { code: 'FILE_TOO_LARGE', message: 'CV file must not exceed 10 MB' } });
    }

    const candidate = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: {
        id: true,
        fullName: true,
        jobId: true,
        currentRole: true,
        yearsExperience: true,
        skills: true,
        isScoreOverridden: true,
      },
    });
    if (!candidate) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Candidate not found' } });
    }

    // 1. Upload to R2 (validates MIME type; throws BadRequest on unsupported type).
    let cvFileUrl: string;
    try {
      cvFileUrl = await this.storageService.uploadFromBuffer(file.buffer, file.mimetype, tenantId, candidateId);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new InternalServerErrorException({ error: { code: 'UPLOAD_FAILED', message: 'Failed to upload CV file' } });
    }

    // 2. Extract text (extractor already sanitizes; sanitize again defensively).
    const attachments: EmailAttachmentDto[] = [
      {
        Name: file.originalname,
        Content: file.buffer.toString('base64'),
        ContentType: file.mimetype,
        ContentLength: file.size,
      },
    ];
    const cvText = sanitizePgText(await this.attachmentExtractor.extract(attachments));

    // 3. Regenerate the AI summary.
    let jobTitle: string | null = null;
    if (candidate.jobId) {
      const job = await this.prisma.job.findFirst({
        where: { id: candidate.jobId, tenantId },
        select: { title: true },
      });
      jobTitle = job?.title ?? null;
    }
    const aiSummary = await this.candidateAiService.generateSummary({
      fullName: candidate.fullName,
      currentRole: candidate.currentRole,
      yearsExperience: candidate.yearsExperience,
      skills: candidate.skills,
      cvText,
      jobTitle,
    });

    // 4. Persist the new CV text + summary + file url.
    await this.prisma.candidate.update({
      where: { id: candidateId },
      data: { cvFileUrl, cvText, aiSummary },
    });

    // 5. Re-score only when a job is assigned, CV text exists, and no sticky override.
    if (candidate.jobId && cvText.trim() !== '' && !candidate.isScoreOverridden) {
      await this.rescoreAssignedJob(
        {
          id: candidate.id,
          jobId: candidate.jobId,
          cvText,
          currentRole: candidate.currentRole,
          yearsExperience: candidate.yearsExperience,
          skills: candidate.skills,
        },
        tenantId,
      );
    }

    return this.findOne(candidateId, tenantId);
  }

  async saveStageSummary(
    candidateId: string,
    stageId: string,
    summary: string,
    tenantId: string,
  ): Promise<{ success: boolean }> {
    // Verifying candidate ownership essentially
    const candidate = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: { id: true, jobId: true },
    });

    if (!candidate) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Candidate not found' } });

    if (!candidate.jobId) {
      throw new BadRequestException({
        error: { code: 'NO_JOB', message: 'Candidate is not assigned to any job pipeline' },
      });
    }

    const stage = await this.prisma.jobStage.findFirst({
      where: { id: stageId, jobId: candidate.jobId, tenantId },
    });

    if (!stage) {
      throw new BadRequestException({
        error: { code: 'STAGE_NOT_FOUND', message: "Stage does not belong to the candidate's assigned job" },
      });
    }

    await this.prisma.candidateStageSummary.upsert({
      where: {
        idx_cand_stage_summary: {
          candidateId,
          jobStageId: stageId,
        },
      },
      update: { summary },
      create: {
        tenantId,
        candidateId,
        jobStageId: stageId,
        summary,
      },
    });

    return { success: true };
  }

  async advanceWithSummary(
    candidateId: string,
    currentStageId: string,
    summary: string,
    tenantId: string,
  ): Promise<{ success: boolean; hiring_stage_id: string }> {
    await this.saveStageSummary(candidateId, currentStageId, summary, tenantId);

    const candidate = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: { id: true, jobId: true },
    });

    if (!candidate || !candidate.jobId) {
      throw new BadRequestException({
        error: { code: 'NO_JOB', message: 'Candidate is not assigned to any job pipeline' },
      });
    }

    // Identify next stage
    const stages = await this.prisma.jobStage.findMany({
      where: { jobId: candidate.jobId, tenantId, isEnabled: true },
      orderBy: { order: 'asc' },
      select: { id: true },
    });

    const currentIndex = stages.findIndex((s) => s.id === currentStageId);
    if (currentIndex === -1) {
      throw new BadRequestException({
        error: { code: 'STAGE_NOT_FOUND', message: 'Current stage not found in job pipeline' },
      });
    }

    if (currentIndex === stages.length - 1) {
      throw new BadRequestException({
        error: { code: 'LAST_STAGE', message: 'Candidate is already at the last hiring stage' },
      });
    }

    const nextStageId = stages[currentIndex + 1].id;

    // Use updateStage for robust atomic dual updating!
    await this.updateStage(candidateId, { hiring_stage_id: nextStageId }, tenantId);

    return { success: true, hiring_stage_id: nextStageId };
  }

  async updateStage(candidateId: string, dto: UpdateCandidateStageDto, tenantId: string): Promise<void> {
    await moveCandidateToStage(this.prisma, candidateId, dto.hiring_stage_id, tenantId);
  }

  async deleteCandidate(candidateId: string, tenantId: string): Promise<void> {
    // Verify the candidate exists and belongs to this tenant
    const candidate = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: { id: true },
    });

    if (!candidate) {
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'Candidate not found' },
      });
    }

    await this.prisma.$transaction(async (tx) => {
      // 1. Delete DuplicateFlag rows where this candidate appears on either side
      //    (schema uses onDelete: Restrict — must remove manually)
      await tx.duplicateFlag.deleteMany({
        where: {
          OR: [{ candidateId }, { matchedCandidateId: candidateId }],
        },
      });

      // 2. Nullify EmailIntakeLog.candidateId (optional FK, no cascade defined)
      await tx.emailIntakeLog.updateMany({
        where: { candidateId },
        data: { candidateId: null },
      });

      // 3. Delete the candidate — Application rows cascade (onDelete: Cascade)
      //    and CandidateJobScore cascades from Application
      await tx.candidate.delete({
        where: { id: candidateId },
      });
    });
  }

  async createCandidate(
    dto: CreateCandidateDto,
    file: Express.Multer.File | undefined,
    tenantId: string,
  ): Promise<Record<string, unknown>> {
    // Pre-validation 1: validate job exists in the same tenant
    const job = await this.prisma.job.findFirst({
      where: { id: dto.job_id, tenantId },
    });

    if (!job) {
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'Job not found' },
      });
    }

    // Pre-validation 2: validate email uniqueness (only if email provided)
    if (dto.email) {
      const existing = await this.prisma.candidate.findFirst({
        where: { tenantId, email: dto.email },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException({
          error: {
            code: 'EMAIL_EXISTS',
            message: 'A candidate with this email already exists',
          },
        });
      }
    }

    // Generate candidate ID before upload so R2 key matches the candidate record
    const candidateId = crypto.randomUUID();

    // File upload (before transaction — external service)
    let cvFileUrl: string | null = null;
    if (file) {
      try {
        cvFileUrl = await this.storageService.uploadFromBuffer(file.buffer, file.mimetype, tenantId, candidateId);
      } catch (err) {
        if (err instanceof BadRequestException) {
          throw err;
        }
        throw new InternalServerErrorException({
          error: { code: 'UPLOAD_FAILED', message: 'Failed to upload CV file' },
        });
      }
    }

    // Pre-fetch first hiring stage if job_id is provided
    let firstStageId: string | null = null;
    if (dto.job_id) {
      const firstStage = await this.prisma.jobStage.findFirst({
        where: {
          jobId: dto.job_id,
          tenantId,
        },
        orderBy: { order: 'asc' },
        select: { id: true },
      });

      if (firstStage) {
        firstStageId = firstStage.id;
      } else {
        this.logger.warn(
          `Candidate created with job_id ${dto.job_id} but no hiring stages found. ` +
            `Candidate will have hiringStageId=null.`,
        );
      }
    }

    let aiSummary = dto.ai_summary ?? null;
    if (dto.job_id && job && !aiSummary) {
      aiSummary = await this.candidateAiService.generateSummary({
        fullName: dto.full_name,
        currentRole: dto.current_role,
        yearsExperience: dto.years_experience,
        skills: dto.skills ?? [],
        cvText: null,
        jobTitle: job.title,
      });
    }

    // Atomic transaction: create Candidate + Application
    const { candidate, application } = await this.prisma.$transaction(async (tx) => {
      const candidate = await tx.candidate.create({
        data: {
          id: candidateId,
          tenantId,
          jobId: dto.job_id,
          hiringStageId: firstStageId,
          fullName: dto.full_name,
          email: dto.email ?? null,
          phone: dto.phone ?? null,
          currentRole: dto.current_role ?? null,
          location: dto.location ?? null,
          yearsExperience: dto.years_experience ?? null,
          salaryExpectationMin: dto.salary_expectation_min ?? null,
          salaryExpectationMax: dto.salary_expectation_max ?? null,
          skills: dto.skills ?? [],
          cvText: null, // D-02: null for manual adds
          cvFileUrl,
          source: dto.source,
          sourceAgency: dto.source_agency ?? null,
          sourceEmail: null,
          aiSummary,
        },
      });

      const application = await tx.application.create({
        data: {
          tenantId,
          candidateId: candidate.id,
          jobId: dto.job_id,
          stage: 'new', // D-04
          jobStageId: firstStageId,
          appliedAt: new Date(),
        },
      });

      return { candidate, application };
    });

    // Map to snake_case response (D-03)
    return {
      id: candidate.id,
      job_id: candidate.jobId,
      hiring_stage_id: candidate.hiringStageId,
      full_name: candidate.fullName,
      email: candidate.email,
      phone: candidate.phone,
      current_role: candidate.currentRole,
      location: candidate.location,
      years_experience: candidate.yearsExperience,
      salary_expectation_min: candidate.salaryExpectationMin,
      salary_expectation_max: candidate.salaryExpectationMax,
      skills: candidate.skills,
      cv_file_url: candidate.cvFileUrl,
      source: candidate.source,
      source_agency: candidate.sourceAgency,
      ai_summary: candidate.aiSummary,
      cv_readable: computeCvReadable(candidate.cvText),
      is_score_overridden: candidate.isScoreOverridden,
      created_at: candidate.createdAt,
      updated_at: candidate.updatedAt,
      application_id: application.id,
    };
  }

  async getCvPresignedUrl(candidateId: string, tenantId: string): Promise<{ url: string }> {
    const candidate = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: { cvFileUrl: true },
    });

    if (!candidate) {
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'Candidate not found' },
      });
    }

    if (!candidate.cvFileUrl) {
      throw new NotFoundException({
        error: { code: 'NO_CV', message: 'No CV file found for this candidate' },
      });
    }

    const url = await this.storageService.getPresignedUrl(candidate.cvFileUrl);
    return { url };
  }

  /**
   * Stream the candidate's CV bytes same-origin so the browser can render them
   * (e.g. docx-preview) without relying on R2 CORS. Tenant-scoped.
   */
  async getCvBytes(
    candidateId: string,
    tenantId: string,
  ): Promise<{ body: Buffer; contentType: string; filename: string }> {
    const candidate = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: { cvFileUrl: true, fullName: true },
    });

    if (!candidate) {
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'Candidate not found' },
      });
    }

    if (!candidate.cvFileUrl) {
      throw new NotFoundException({
        error: { code: 'NO_CV', message: 'No CV file found for this candidate' },
      });
    }

    let body: Buffer;
    let contentType: string;
    try {
      ({ body, contentType } = await this.storageService.getObject(candidate.cvFileUrl));
    } catch (err) {
      // Stale key (object deleted / never stored) → treat as "no CV" rather than a
      // opaque 500. R2/S3 raises NoSuchKey on GetObject; NotFound on some backends.
      const name = err instanceof Error ? err.name : '';
      if (name === 'NoSuchKey' || name === 'NotFound') {
        throw new NotFoundException({
          error: { code: 'NO_CV', message: 'No CV file found for this candidate' },
        });
      }
      throw err;
    }
    // Derive the extension from the key's basename only — keys look like
    // `cvs/<tenant>/<id>.pdf`, so splitting the whole path on '.' could otherwise
    // return the entire key (with slashes) when a basename has no extension.
    const basename = candidate.cvFileUrl.split('/').pop() ?? '';
    const ext = basename.includes('.') ? basename.split('.').pop()!.toLowerCase() || 'bin' : 'bin';
    // Keep the filename ASCII-safe for the Content-Disposition header.
    const safeName = (candidate.fullName || 'cv').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'cv';
    return { body, contentType, filename: `${safeName}.${ext}` };
  }
}
