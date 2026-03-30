import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { CreateJobDto } from './dto/create-job.dto';

const DEFAULT_HIRING_STAGES = [
  { name: 'Application Review', order: 1, isCustom: false, color: 'bg-zinc-400', isEnabled: true },
  { name: 'Screening', order: 2, isCustom: false, color: 'bg-blue-500', isEnabled: true },
  { name: 'Interview', order: 3, isCustom: false, color: 'bg-indigo-400', isEnabled: true },
  { name: 'Offer', order: 4, isCustom: false, color: 'bg-emerald-500', isEnabled: true },
  { name: 'Hired', order: 5, isCustom: false, color: 'bg-green-600', isEnabled: false },
  { name: 'Rejected', order: 6, isCustom: false, color: 'bg-red-500', isEnabled: false },
  { name: 'Pending Decision', order: 7, isCustom: false, color: 'bg-yellow-400', isEnabled: false },
  { name: 'On Hold', order: 8, isCustom: false, color: 'bg-gray-500', isEnabled: false },
];

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async findAll(status?: string): Promise<{ jobs: any[]; total: number }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    const jobs = await this.prisma.job.findMany({
      where: { tenantId, ...(status ? { status } : {}) },
      include: {
        hiringStages: { orderBy: { order: 'asc' } },
        screeningQuestions: { orderBy: { order: 'asc' } },
        _count: { select: { candidates: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      jobs: jobs.map((job) => this._formatJobResponse(job)),
      total: jobs.length,
    };
  }

  async findOne(id: string): Promise<any> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    const job = await this.prisma.job.findFirst({
      where: { id, tenantId },
      include: {
        hiringStages: { orderBy: { order: 'asc' } },
        screeningQuestions: { orderBy: { order: 'asc' } },
        _count: { select: { candidates: true } },
      },
    });

    if (!job) {
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'Job not found' },
      });
    }

    return this._formatJobResponse(job);
  }

  async createJob(dto: CreateJobDto): Promise<any> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    // Use provided stages, or auto-seed 4 defaults if hiring_flow is omitted/empty
    const stagesToCreate =
      dto.hiring_flow && dto.hiring_flow.length > 0
        ? dto.hiring_flow.map((s) => ({
            tenantId,
            name: s.name,
            order: s.order,
            interviewer: s.interviewer ?? null,
            color: s.color,
            isEnabled: s.is_enabled ?? true,
            isCustom: s.is_custom ?? false,
          }))
        : DEFAULT_HIRING_STAGES.map((s) => ({ ...s, tenantId }));

    const questionsToCreate = (dto.screening_questions ?? []).map((q, i) => ({
      tenantId,
      text: q.text,
      answerType: q.type,
      expectedAnswer: q.expected_answer ?? null,
      order: q.order ?? i + 1,
    }));

    return this.prisma.$transaction(async (tx) => {
      const job = await tx.job.create({
        data: {
          tenantId,
          title: dto.title,
          description: dto.description ?? null,
          department: dto.department ?? null,
          location: dto.location ?? null,
          jobType: dto.job_type ?? 'full_time',
          status: dto.status ?? 'draft',
          salaryRange: dto.salary_range ?? null,
          hiringManager: dto.hiring_manager ?? null,
          responsibilities: dto.responsibilities ?? null,
          whatWeOffer: dto.what_we_offer ?? null,
          mustHaveSkills: dto.must_have_skills ?? [],
          niceToHaveSkills: dto.nice_to_have_skills ?? [],
          expYearsMin: dto.min_experience ?? null,
          expYearsMax: dto.max_experience ?? null,
          preferredOrgTypes: dto.selected_org_types ?? [],
          hiringStages: { create: stagesToCreate },
          screeningQuestions: { create: questionsToCreate },
        },
        include: {
          hiringStages: { orderBy: { order: 'asc' } },
          screeningQuestions: { orderBy: { order: 'asc' } },
          _count: { select: { candidates: true } },
        },
      });

      return this._formatJobResponse(job);
    });
  }

  async updateJob(id: string, dto: CreateJobDto): Promise<any> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    await this.prisma.job.findFirstOrThrow({
      where: { id, tenantId },
    });

    const stagesToCreate =
      dto.hiring_flow && dto.hiring_flow.length > 0
        ? dto.hiring_flow.map((s) => ({
            tenantId,
            name: s.name,
            order: s.order,
            interviewer: s.interviewer ?? null,
            color: s.color,
            isEnabled: s.is_enabled ?? true,
            isCustom: s.is_custom ?? false,
          }))
        : DEFAULT_HIRING_STAGES.map((s) => ({ ...s, tenantId }));

    const questionsToCreate = (dto.screening_questions ?? []).map((q, i) => ({
      tenantId,
      text: q.text,
      answerType: q.type,
      expectedAnswer: q.expected_answer ?? null,
      order: q.order ?? i + 1,
    }));

    return this.prisma.$transaction(async (tx) => {
      // ── FIX: Safely detach candidates before deleting stages ───────────
      // The DB has a CHECK constraint: if job_id is set, hiring_stage_id must not be null.
      // Deleting stages triggers onDelete:SetNull on hiringStageId, which violates the constraint.
      // Solution: temporarily nullify BOTH jobId and hiringStageId, then reassign after new stages are created.

      // 1. Detach candidates from their stages (nullify both to satisfy constraint)
      await tx.candidate.updateMany({
        where: { jobId: id, tenantId },
        data: { hiringStageId: null, jobId: null },
      });

      // 2. Detach applications from their stages
      await tx.application.updateMany({
        where: { jobId: id, tenantId },
        data: { jobStageId: null },
      });

      // 3. Now safe to delete old stages and recreate
      const job = await tx.job.update({
        where: { id, tenantId },
        data: {
          title: dto.title,
          description: dto.description ?? null,
          department: dto.department ?? null,
          location: dto.location ?? null,
          jobType: dto.job_type ?? 'full_time',
          status: dto.status ?? 'draft',
          salaryRange: dto.salary_range ?? null,
          hiringManager: dto.hiring_manager ?? null,
          responsibilities: dto.responsibilities ?? null,
          whatWeOffer: dto.what_we_offer ?? null,
          mustHaveSkills: dto.must_have_skills ?? [],
          niceToHaveSkills: dto.nice_to_have_skills ?? [],
          expYearsMin: dto.min_experience ?? null,
          expYearsMax: dto.max_experience ?? null,
          preferredOrgTypes: dto.selected_org_types ?? [],
          hiringStages: {
            deleteMany: {},
            create: stagesToCreate,
          },
          screeningQuestions: {
            deleteMany: {},
            create: questionsToCreate,
          },
        },
        include: {
          hiringStages: { orderBy: { order: 'asc' } },
          screeningQuestions: { orderBy: { order: 'asc' } },
          _count: { select: { candidates: true } },
        },
      });

      // 4. Re-attach candidates to the job and assign them to the first stage
      const firstStage = job.hiringStages[0];
      if (firstStage) {
        await tx.candidate.updateMany({
          where: {
            // Find candidates that were detached (jobId is null but have an application for this job)
            tenantId,
            jobId: null,
            applications: { some: { jobId: id } },
          },
          data: {
            jobId: id,
            hiringStageId: firstStage.id,
          },
        });

        // 5. Re-attach applications to the first stage
        await tx.application.updateMany({
          where: { jobId: id, tenantId },
          data: { jobStageId: firstStage.id },
        });
      } else {
        // No stages — just re-attach candidates to the job without a stage
        // This path should not happen since validation requires at least one enabled stage
        await tx.candidate.updateMany({
          where: {
            tenantId,
            jobId: null,
            applications: { some: { jobId: id } },
          },
          data: { jobId: id },
        });
      }

      return this._formatJobResponse(job);
    });
  }

  async getOpenJobs(): Promise<{ jobs: Array<{ id: string; title: string; department: string | null }> }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    const jobs = await this.prisma.job.findMany({
      where: { tenantId, status: 'open' },
      select: {
        id: true,
        title: true,
        department: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      jobs: jobs.map((j) => ({
        id: j.id,
        title: j.title,
        department: j.department,
      })),
    };
  }

  async deleteJob(id: string): Promise<void> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    // Verify exists before update
    const job = await this.prisma.job.findFirst({
      where: { id, tenantId },
    });

    if (!job) {
      throw new NotFoundException({
        error: {
          code: 'NOT_FOUND',
          message: 'Job not found',
        },
      });
    }

    // Soft delete: set status=closed
    await this.prisma.job.update({
      where: { id },
      data: { status: 'closed' },
    });
  }

  async hardDeleteJob(id: string): Promise<void> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    // Verify exists and belongs to this tenant
    const job = await this.prisma.job.findFirst({
      where: { id, tenantId },
    });

    if (!job) {
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'Job not found' },
      });
    }

    // Hard delete — Prisma/DB cascades handle the cleanup:
    //   - JobStage       → onDelete: Cascade  ✓
    //   - ScreeningQuestion → onDelete: Cascade  ✓
    //   - Application    → onDelete: Cascade  ✓  (CandidateJobScore cascades from Application)
    //   - Candidate.jobId / hiringStageId → onDelete: SetNull  ✓
    await this.prisma.job.delete({ where: { id } });
  }

  private _formatJobResponse(job: any) {
    return {
      id: job.id,
      title: job.title,
      department: job.department,
      location: job.location,
      job_type: job.jobType,
      status: job.status,
      hiring_manager: job.hiringManager,
      candidate_count: job._count?.candidates ?? 0,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
      description: job.description,
      responsibilities: job.responsibilities,
      what_we_offer: job.whatWeOffer,
      salary_range: job.salaryRange,
      must_have_skills: job.mustHaveSkills ?? [],
      nice_to_have_skills: job.niceToHaveSkills ?? [],
      min_experience: job.expYearsMin,
      max_experience: job.expYearsMax,
      selected_org_types: job.preferredOrgTypes ?? [],
      screening_questions: (job.screeningQuestions ?? []).map((q: any) => ({
        id: q.id,
        text: q.text,
        type: q.answerType,
        expected_answer: q.expectedAnswer ?? null,
      })),
      hiring_flow: (job.hiringStages ?? []).map((s: any) => ({
        id: s.id,
        name: s.name,
        is_enabled: s.isEnabled,
        interviewer: s.interviewer ?? null,
        color: s.color,
        is_custom: s.isCustom,
        order: s.order,
      })),
    };
  }
}
