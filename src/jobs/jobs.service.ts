import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

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
}
