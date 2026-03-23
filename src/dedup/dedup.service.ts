import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CandidateExtract } from '../ingestion/services/extraction-agent.service';

export interface FuzzyMatch {
  id: string;
  full_name: string;
  name_sim: number;
}

export interface DedupResult {
  match: { id: string };
  confidence: number;
  fields: string[];
}

@Injectable()
export class DedupService {
  constructor(private readonly prisma: PrismaService) {}

  async check(
    candidate: CandidateExtract,
    tenantId: string,
  ): Promise<DedupResult | null> {
    // Step 1: Exact email match — skip if email is null (NULL = NULL is always false in SQL)
    if (candidate.email) {
      const exact = await this.prisma.candidate.findFirst({
        where: { tenantId, email: candidate.email },
        select: { id: true },
      });
      if (exact) {
        return { match: { id: exact.id }, confidence: 1.0, fields: ['email'] };
      }
    }

    // Step 2: Fuzzy name match via pg_trgm — runs entirely in PostgreSQL (DEDUP-01)
    // Compute reversed token order to catch "Smith John" matching stored "John Smith" (DEDUP-06)
    const reversedName = candidate.fullName.trim().split(/\s+/).reverse().join(' ');

    const fuzzy = await this.prisma.$queryRaw<FuzzyMatch[]>`
      SELECT id::text, full_name,
             GREATEST(
               similarity(full_name, ${candidate.fullName}),
               similarity(full_name, ${reversedName})
             ) AS name_sim
      FROM candidates
      WHERE tenant_id = ${tenantId}::uuid
        AND (
          similarity(full_name, ${candidate.fullName}) > 0.7
          OR similarity(full_name, ${reversedName}) > 0.7
        )
      ORDER BY name_sim DESC
      LIMIT 1
    `;

    if (fuzzy.length > 0) {
      return {
        match: { id: fuzzy[0].id },
        confidence: fuzzy[0].name_sim,
        fields: ['name'],
      };
    }

    return null;
  }

  async insertCandidate(
    candidate: CandidateExtract,
    tenantId: string,
    fromEmail: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    const client = tx ?? this.prisma;
    const created = await client.candidate.create({
      data: {
        tenantId,
        fullName: candidate.fullName,
        email: candidate.email ?? null,
        phone: candidate.phone ?? null,
        source: candidate.source ?? 'direct',
        sourceEmail: fromEmail,
        // Phase 7 enriches: currentRole, yearsExperience, skills, cvText, cvFileUrl, aiSummary, metadata
      },
      select: { id: true },
    });
    return created.id;
  }

  async upsertCandidate(
    candidateId: string,
    candidate: CandidateExtract,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.candidate.update({
      where: { id: candidateId },
      data: {
        fullName: candidate.fullName,
        phone: candidate.phone ?? null,
        // source and sourceEmail intentionally NOT updated — first-submission wins (D-07)
      },
    });
  }

  async createFlag(
    candidateId: string,
    matchedCandidateId: string,
    confidence: number,
    tenantId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.duplicateFlag.upsert({
      where: {
        idx_duplicates_pair: { tenantId, candidateId, matchedCandidateId },
      },
      create: {
        tenantId,
        candidateId,
        matchedCandidateId,
        confidence: new Prisma.Decimal(confidence.toString()),
        matchFields: ['name'],
        reviewed: false,
      },
      update: {}, // No-op on BullMQ retry — idempotent (D-13)
    });
  }
}
