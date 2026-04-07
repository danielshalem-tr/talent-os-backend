import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CandidateExtract } from '../ingestion/services/extraction-agent.service';

export interface DedupResult {
  match: { id: string } | null;
  confidence: number;
  fields: string[];
}

@Injectable()
export class DedupService {
  constructor(private readonly prisma: PrismaService) {}

  async check(
    candidate: CandidateExtract,
    tenantId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DedupResult | null> {
    const client = tx ?? this.prisma;
    // Step 1: No phone — return sentinel so processor can create phone_missing flag for HR review
    if (!candidate.phone || candidate.phone.trim() === '') {
      return { match: null, confidence: 0, fields: ['phone_missing'] };
    }

    // Step 2: Exact phone match — strip non-digit characters from both sides before comparing
    const phoneMatches = await client.$queryRaw<{ id: string }[]>`
      SELECT id::text
      FROM candidates
      WHERE tenant_id = ${tenantId}::uuid
        AND regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace(${candidate.phone}, '[^0-9]', '', 'g')
      LIMIT 1
    `;

    if (phoneMatches.length > 0) {
      return { match: { id: phoneMatches[0].id }, confidence: 1.0, fields: ['phone'] };
    }

    // Step 3: No match — new candidate
    return null;
  }

  async insertCandidate(
    candidate: CandidateExtract,
    tenantId: string,
    fromEmail: string,
    tx?: Prisma.TransactionClient,
    source?: string | null, // NEW: optional source from extraction.source_hint
  ): Promise<string> {
    const client = tx ?? this.prisma;
    const created = await client.candidate.create({
      data: {
        tenantId,
        fullName: candidate.full_name,
        email: candidate.email ?? null,
        phone: candidate.phone ?? null,
        source: source ?? 'direct', // CHANGED: use provided source or default to 'direct'
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
        fullName: candidate.full_name,
        phone: candidate.phone ?? null,
        // source and sourceEmail intentionally NOT updated — first-submission wins (D-07)
      },
    });
  }

  async createFlag(
    candidateId: string,
    matchedCandidateId: string | null,
    confidence: number,
    tenantId: string,
    fields: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    // When matchedCandidateId is null (phone_missing case), self-reference satisfies FK constraint
    const resolvedMatchId = matchedCandidateId ?? candidateId;
    const client = tx ?? this.prisma;
    await client.duplicateFlag.upsert({
      where: {
        idx_duplicates_pair: { tenantId, candidateId, matchedCandidateId: resolvedMatchId },
      },
      create: {
        tenantId,
        candidateId,
        matchedCandidateId: resolvedMatchId,
        confidence: new Prisma.Decimal(confidence.toString()),
        matchFields: fields,
        reviewed: false,
      },
      update: {}, // No-op on BullMQ retry — idempotent (D-13)
    });
  }
}
