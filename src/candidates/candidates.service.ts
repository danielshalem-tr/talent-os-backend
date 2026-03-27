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
import { CandidateResponse } from './dto/candidate-response.dto';
import { Prisma } from '@prisma/client';

export type CandidateFilter = 'all' | 'high-score' | 'available' | 'referred' | 'duplicates';

@Injectable()
export class CandidatesService {
  private readonly logger = new Logger(CandidatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly storageService: StorageService,
  ) {}

  async findAll(
    q?: string,
    filter?: CandidateFilter,
    jobId?: string,
  ): Promise<{ candidates: CandidateResponse[]; total: number }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    // Build WHERE conditions
    const where: Record<string, unknown> = { tenantId };

    // ── NEW: filter by job ──────────────────────────────────────────────
    if (jobId) {
      where.jobId = jobId;
    }

    if (q) {
      where.OR = [
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { currentRole: { contains: q, mode: 'insensitive' } },
      ];
    }

    // filter='available': no application in hired or rejected stage
    if (filter === 'available') {
      where.applications = {
        none: { stage: { in: ['hired', 'rejected'] } },
      };
    }

    // filter='referred': source = 'referral'
    if (filter === 'referred') {
      where.source = 'referral';
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
      },
      orderBy: { createdAt: 'desc' },
    });

    // Compute derived fields and map to snake_case
    let result: CandidateResponse[] = candidates.map((c) => {
      // ai_score = MAX score across all applications' scores
      const allScores = c.applications.flatMap((a) => a.scores.map((s) => s.score));
      const aiScore = allScores.length > 0 ? Math.max(...allScores) : null;

      return {
        id: c.id,
        full_name: c.fullName,
        email: c.email,
        phone: c.phone,
        current_role: c.currentRole,
        location: c.location,
        cv_file_url: c.cvFileUrl,
        source: c.source,
        created_at: c.createdAt,
        ai_score: aiScore,
        is_duplicate: c.duplicateFlags.length > 0,
        skills: c.skills,

        // Kanban board fields
        job_id: c.jobId,
        hiring_stage_id: c.hiringStageId,
        hiring_stage_name: c.hiringStage?.name ?? null,
        job_title: c.job?.title ?? null,
      };
    });

    // filter='high-score': ai_score >= 70 (post-query filter since ai_score is computed)
    if (filter === 'high-score') {
      result = result.filter((c) => c.ai_score !== null && c.ai_score >= 70);
    }

    return { candidates: result, total: result.length };
  }

  // ── NEW: Update candidate hiring stage (Kanban drag-and-drop) ─────────
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
          aiSummary: dto.ai_summary ?? null,
          metadata: Prisma.JsonNull as unknown as Prisma.InputJsonValue,
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
      tenant_id: candidate.tenantId,
      job_id: candidate.jobId,
      hiring_stage_id: candidate.hiringStageId,
      full_name: candidate.fullName,
      email: candidate.email,
      phone: candidate.phone,
      current_role: candidate.currentRole,
      location: candidate.location,
      years_experience: candidate.yearsExperience,
      skills: candidate.skills,
      cv_text: candidate.cvText,
      cv_file_url: candidate.cvFileUrl,
      source: candidate.source,
      source_agency: candidate.sourceAgency,
      source_email: candidate.sourceEmail,
      ai_summary: candidate.aiSummary,
      metadata: candidate.metadata,
      created_at: candidate.createdAt,
      updated_at: candidate.updatedAt,
      application_id: application.id,
    };
  }
}
