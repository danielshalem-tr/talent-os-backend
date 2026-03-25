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

  async findAll(): Promise<{ jobs: any[]; total: number }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    const jobs = await this.prisma.job.findMany({
      where: { tenantId },
      include: {
        hiringStages: { orderBy: { order: 'asc' } },
        screeningQuestions: { orderBy: { order: 'asc' } },
        _count: { select: { applications: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      jobs: jobs.map((job) => this._formatJobResponse(job)),
      total: jobs.length,
    };
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
          _count: { select: { applications: true } },
        },
      });

      return this._formatJobResponse(job);
    });
  }

  async updateJob(id: string, dto: CreateJobDto): Promise<any> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    // Verify job exists for this tenant (throws Prisma P2025 if not)
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
          _count: { select: { applications: true } },
        },
      });

      return this._formatJobResponse(job);
    });
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

  private _formatJobResponse(job: any) {
    return {
      id: job.id,
      title: job.title,
      department: job.department,
      location: job.location,
      job_type: job.jobType,
      status: job.status,
      hiring_manager: job.hiringManager,
      candidate_count: job._count?.applications ?? 0,
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
