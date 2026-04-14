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
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../storage/storage.service';
import { CreateCandidateDto } from './dto/create-candidate.dto';
import { UpdateCandidateStageDto } from './dto/update-candidate-stage.dto';
import { UpdateCandidateDto } from './dto/update-candidate.dto';
import { StageSummaryDto } from './dto/stage-summary.dto';
import { RejectCandidateDto } from './dto/reject-candidate.dto';
import { CandidateResponse } from './dto/candidate-response.dto';
import { Prisma } from '@prisma/client';
import { CandidateAiService } from './candidate-ai.service';
import { ScoringAgentService } from '../scoring/scoring.service';

export type CandidateFilter = 'all' | 'duplicates';

@Injectable()
export class CandidatesService {
  private readonly logger = new Logger(CandidatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly storageService: StorageService,
    private readonly candidateAiService: CandidateAiService,
    private readonly scoringAgent: ScoringAgentService,
  ) {}

  async getCounts(): Promise<{ total: number; duplicates: number; unassigned: number }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    const [total, duplicates, unassigned] = await Promise.all([
      this.prisma.candidate.count({
        where: { tenantId, status: 'active' },
      }),
      this.prisma.candidate.count({
        where: {
          tenantId,
          status: 'active',
          duplicateFlags: { some: { reviewed: false } },
        },
      }),
      this.prisma.candidate.count({
        where: { tenantId, status: 'active', jobId: null },
      }),
    ]);

    return { total, duplicates, unassigned };
  }

  async findAll(
    q?: string,
    filter?: CandidateFilter,
    jobId?: string,
    unassigned?: boolean,
  ): Promise<{ candidates: CandidateResponse[]; total: number }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    // Validate filter parameter — only 'all' and 'duplicates' are supported
    // (C-4 fix: prevents silent failures from removed filters like 'high-score', 'available', 'referred')
    if (filter && !['all', 'duplicates'].includes(filter)) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_FILTER',
          message: `Filter '${filter}' is not supported. Use 'all' or 'duplicates'.`,
        },
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

    if (q) {
      where.OR = [
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { currentRole: { contains: q, mode: 'insensitive' } },
      ];
    }

    // filter='duplicates': has unreviewed duplicate_flag
    if (filter === 'duplicates') {
      where.duplicateFlags = {
        some: { reviewed: false },
      };
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
        aiSummary: true,
        aiScore: true,
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
        duplicateFlags: {
          where: { reviewed: false },
          select: { id: true },
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
        ai_summary: c.aiSummary,
        source: c.source,
        source_agency: c.sourceAgency,
        created_at: c.createdAt,
        ai_score: aiScore,
        is_duplicate: c.duplicateFlags.length > 0,
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
      };
    });

    return { candidates: result, total: result.length };
  }

  async findOne(candidateId: string): Promise<CandidateResponse> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

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
        aiSummary: true,
        aiScore: true,
        hiringStage: {
          select: { name: true },
        },
        job: {
          select: { title: true },
        },
        applications: {
          select: {
            scores: {
              select: { score: true },
            },
          },
        },
        duplicateFlags: {
          where: { reviewed: false },
          select: { id: true },
        },
        status: true,
        rejectionReason: true,
        rejectionNote: true,
        candidateStageSummaries: {
          select: { jobStageId: true, summary: true },
        },
      },
    });

    if (!c) {
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'Candidate not found' },
      });
    }

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
      ai_summary: c.aiSummary,
      is_duplicate: c.duplicateFlags.length > 0,
      years_experience: c.yearsExperience,
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
    };
  }

  async updateCandidate(candidateId: string, dto: UpdateCandidateDto): Promise<CandidateResponse> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

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

    // Handle atomic job assignment flow
    if (dto.job_id) {
      if (candidate.jobId === dto.job_id) {
        // Same-job no-op: if no profile fields changed, return early
        if (Object.keys(updateData).length === 0) return this.findOne(candidateId);
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
          select: { id: true, title: true, description: true, mustHaveSkills: true },
        });

        if (!job) {
          throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Job not found' } });
        }

        await this.prisma.$transaction(async (tx) => {
          // 1. Create new Application
          await tx.application.create({
            data: {
              tenantId,
              candidateId,
              jobId: dto.job_id!,
              stage: 'new',
              jobStageId: firstStage.id,
            },
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

          // 3. Score (non-blocking per D-21)
          try {
            const scoreResult = await this.scoringAgent.score({
              cvText: candidate.cvText || '',
              candidateFields: {
                currentRole: dto.current_role ?? candidate.currentRole,
                yearsExperience: dto.years_experience ?? candidate.yearsExperience,
                skills: candidate.skills,
              },
              job: {
                title: job.title,
                description: job.description || '',
                requirements: job.mustHaveSkills || [],
              },
            });

            // Get the application we just created to attach scores
            const newApp = await tx.application.findFirst({
              where: { candidateId, jobId: dto.job_id, tenantId },
            });

            if (newApp) {
              await tx.candidateJobScore.create({
                data: {
                  tenantId,
                  applicationId: newApp.id,
                  score: scoreResult.score,
                  reasoning: scoreResult.reasoning,
                  strengths: scoreResult.strengths,
                  gaps: scoreResult.gaps,
                  modelUsed: scoreResult.modelUsed,
                },
              });

              // Update denormalized aiScore on candidate
              await tx.candidate.update({
                where: { id: candidateId },
                data: { aiScore: scoreResult.score },
              });
            }
          } catch (err) {
            this.logger.warn(`Scoring failed during reassignment: ${err.message}`);
            // Continue — do not block reassignment
          }
        });

        return this.findOne(candidateId);
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
          select: { title: true },
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
          // 1. Create mapping application
          await tx.application.create({
            data: {
              tenantId,
              candidateId,
              jobId: dto.job_id!,
              stage: 'new',
              jobStageId: firstStage.id,
            },
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

        return this.findOne(candidateId); // Early return post transaction
      }
    }

    // Standard fallback update if no job_id was newly assigned
    if (Object.keys(updateData).length > 0) {
      await this.prisma.candidate.update({
        where: { id: candidateId },
        data: updateData,
      });
    }

    return this.findOne(candidateId);
  }

  async rejectCandidate(candidateId: string, dto: RejectCandidateDto): Promise<CandidateResponse> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;
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

    return this.findOne(candidateId);
  }

  async saveStageSummary(candidateId: string, stageId: string, summary: string): Promise<{ success: boolean }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

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
  ): Promise<{ success: boolean; hiring_stage_id: string }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    await this.saveStageSummary(candidateId, currentStageId, summary);

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
    await this.updateStage(candidateId, { hiring_stage_id: nextStageId });

    return { success: true, hiring_stage_id: nextStageId };
  }

  async updateStage(candidateId: string, dto: UpdateCandidateStageDto): Promise<void> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    // 1. Find the candidate and verify ownership
    const candidate = await this.prisma.candidate.findFirst({
      where: { id: candidateId, tenantId },
      select: { id: true, jobId: true },
    });

    if (!candidate) {
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'Candidate not found' },
      });
    }

    if (!candidate.jobId) {
      throw new BadRequestException({
        error: { code: 'NO_JOB', message: 'Candidate is not linked to a job' },
      });
    }

    // 2. Validate the target stage belongs to the candidate's job
    const stage = await this.prisma.jobStage.findFirst({
      where: {
        id: dto.hiring_stage_id,
        jobId: candidate.jobId,
        tenantId,
      },
    });

    if (!stage) {
      throw new NotFoundException({
        error: {
          code: 'STAGE_NOT_FOUND',
          message: 'Hiring stage not found for this job',
        },
      });
    }

    // 3. Atomic update: candidate.hiringStageId + application.jobStageId
    await this.prisma.$transaction(async (tx) => {
      // Update the candidate's current stage
      await tx.candidate.update({
        where: { id: candidateId },
        data: { hiringStageId: dto.hiring_stage_id },
      });

      // Sync the matching application record
      await tx.application.updateMany({
        where: {
          candidateId,
          jobId: candidate.jobId!,
          tenantId,
        },
        data: { jobStageId: dto.hiring_stage_id },
      });
    });
  }

  async deleteCandidate(candidateId: string): Promise<void> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

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
  ): Promise<Record<string, unknown>> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

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
      skills: candidate.skills,
      cv_file_url: candidate.cvFileUrl,
      source: candidate.source,
      source_agency: candidate.sourceAgency,
      ai_summary: candidate.aiSummary,
      created_at: candidate.createdAt,
      updated_at: candidate.updatedAt,
      application_id: application.id,
    };
  }

  async getCvPresignedUrl(candidateId: string): Promise<{ url: string }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

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
}
