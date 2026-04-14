import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ApplicationCandidateResponse {
  id: string;
  full_name: string;
  email: string | null;
  cv_file_url: string | null;
  ai_score: number | null;
}

export interface ApplicationResponse {
  id: string;
  candidate_id: string;
  job_id: string;
  stage: string;
  applied_at: Date;
  candidate: ApplicationCandidateResponse;
}

@Injectable()
export class ApplicationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string): Promise<{ applications: ApplicationResponse[] }> {
    const applications = await this.prisma.application.findMany({
      where: { tenantId },
      include: {
        candidate: {
          select: {
            id: true,
            fullName: true,
            email: true,
            cvFileUrl: true,
          },
        },
        scores: {
          select: { score: true },
        },
      },
      orderBy: { appliedAt: 'desc' },
    });

    const result: ApplicationResponse[] = applications.map((a) => {
      const allScores = a.scores.map((s) => s.score);
      const aiScore = allScores.length > 0 ? Math.max(...allScores) : null;

      return {
        id: a.id,
        candidate_id: a.candidateId,
        job_id: a.jobId,
        stage: a.stage,
        applied_at: a.appliedAt,
        candidate: {
          id: a.candidate.id,
          full_name: a.candidate.fullName,
          email: a.candidate.email,
          cv_file_url: a.candidate.cvFileUrl,
          ai_score: aiScore,
        },
      };
    });

    return { applications: result };
  }
}
