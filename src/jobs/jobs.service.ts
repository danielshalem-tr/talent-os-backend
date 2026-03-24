import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { CreateJobDto } from './dto/create-job.dto';

export interface JobResponse {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  job_type: string;
  status: string;
  hiring_manager: string | null;
  candidate_count: number;
  created_at: Date;
}

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async findAll(): Promise<{ jobs: JobResponse[]; total: number }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    const jobs = await this.prisma.job.findMany({
      where: { tenantId },
      include: {
        _count: { select: { applications: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const result: JobResponse[] = jobs.map((j) => ({
      id: j.id,
      title: j.title,
      department: j.department,
      location: j.location,
      job_type: j.jobType,
      status: j.status,
      hiring_manager: j.hiringManager,
      candidate_count: j._count.applications,
      created_at: j.createdAt,
    }));

    return { jobs: result, total: result.length };
  }

  async createJob(dto: CreateJobDto) {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    // D-07: use provided stages, or auto-seed 4 defaults (D-04)
    const hiringStages = dto.hiringStages && dto.hiringStages.length > 0
      ? dto.hiringStages.map((s) => ({ ...s, tenantId }))
      : [
          { tenantId, name: 'Application Review', order: 1, isCustom: false },
          { tenantId, name: 'Screening', order: 2, isCustom: false },        // D-05: isCustom=false
          { tenantId, name: 'Interview', order: 3, isCustom: false },
          { tenantId, name: 'Offer', order: 4, isCustom: false },
        ];

    const screeningQuestions = (dto.screeningQuestions ?? []).map((q, i) => ({
      tenantId,
      text: q.text,
      answerType: q.answerType,
      required: q.required ?? false,
      knockout: q.knockout ?? false,
      order: q.order ?? i + 1,
    }));

    return this.prisma.job.create({
      data: {
        tenantId,
        title: dto.title,
        description: dto.description ?? null,
        requirements: dto.requirements ?? [],
        department: dto.department ?? null,
        location: dto.location ?? null,
        jobType: dto.jobType ?? 'full_time',
        status: dto.status ?? 'draft',
        salaryRange: dto.salaryRange ?? null,
        hiringManager: dto.hiringManager ?? null,
        roleSummary: dto.roleSummary ?? null,
        responsibilities: dto.responsibilities ?? null,
        whatWeOffer: dto.whatWeOffer ?? null,
        mustHaveSkills: dto.mustHaveSkills ?? [],
        niceToHaveSkills: dto.niceToHaveSkills ?? [],
        expYearsMin: dto.expYearsMin ?? null,
        expYearsMax: dto.expYearsMax ?? null,
        preferredOrgTypes: dto.preferredOrgTypes ?? [],
        hiringStages: { create: hiringStages },
        screeningQuestions: { create: screeningQuestions },
      },
      include: {
        hiringStages: { orderBy: { order: 'asc' } },
        screeningQuestions: { orderBy: { order: 'asc' } },
      },
    });
  }
}
