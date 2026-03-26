import 'multer';
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../storage/storage.service';
import { CreateCandidateDto } from './dto/create-candidate.dto';
import { Prisma } from '@prisma/client';

export type CandidateFilter = 'all' | 'high-score' | 'available' | 'referred' | 'duplicates';

export interface CandidateResponse {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  current_role: string | null;
  location: string | null;
  cv_file_url: string | null;
  source: string;
  created_at: Date;
  ai_score: number | null;
  is_duplicate: boolean;
  skills: string[];
}

@Injectable()
export class CandidatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly storageService: StorageService,
  ) {}

  async findAll(q?: string, filter?: CandidateFilter): Promise<{ candidates: CandidateResponse[]; total: number }> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    // Build WHERE conditions
    const where: Record<string, unknown> = { tenantId };

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
      };
    });

    // filter='high-score': ai_score >= 70 (post-query filter since ai_score is computed)
    if (filter === 'high-score') {
      result = result.filter((c) => c.ai_score !== null && c.ai_score >= 70);
    }

    return { candidates: result, total: result.length };
  }

  async createCandidate(
    dto: CreateCandidateDto,
    file: Express.Multer.File | undefined,
  ): Promise<Record<string, unknown>> {
    const tenantId = this.configService.get<string>('TENANT_ID')!;

    // Pre-validation 1: validate job exists in tenant
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

    // Atomic transaction: create Candidate + Application
    const { candidate, application } = await this.prisma.$transaction(async (tx) => {
      const candidate = await tx.candidate.create({
        data: {
          id: candidateId,
          tenantId,
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
          sourceEmail: null, // D-02: null for manual adds
          aiSummary: dto.ai_summary ?? null,
          metadata: Prisma.JsonNull as unknown as Prisma.InputJsonValue, // D-02: null for manual adds
        },
      });

      const application = await tx.application.create({
        data: {
          tenantId,
          candidateId: candidate.id,
          jobId: dto.job_id,
          stage: 'new', // D-04
          appliedAt: new Date(),
        },
      });

      return { candidate, application };
    });

    // Map to snake_case response (D-03)
    return {
      id: candidate.id,
      tenant_id: candidate.tenantId,
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
