import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CandidateExtract } from '../ingestion/services/extraction-agent.service';
import { emailIdentity, normalizeEmail, phoneDigits } from './contact-normalize';
import { findCandidatesByPhoneDigits } from './phone-lookup';
import { EnrichmentFields } from '../ingestion/merge-enrichment';

/**
 * Outcome of the identity check for an incoming submission.
 * - `match`: this person already exists → the caller REUSES that row (no insert, no flag).
 * - `new`: insert a fresh row. `sharedPhoneWith` is set when another candidate holds the same
 *   phone but a different, non-null email (family / agency phone): two people, logged, no flag.
 */
export type DedupCheck =
  | { outcome: 'match'; candidateId: string; field: 'email' | 'phone' }
  | { outcome: 'new'; sharedPhoneWith: string | null };

export type ContactField = 'email' | 'phone' | 'fullName';

/** Everything extraction already knows about a brand-new candidate — written at INSERT time. */
export type CandidateEnrichment = Pick<
  EnrichmentFields,
  'currentRole' | 'yearsExperience' | 'location' | 'skills' | 'cvText' | 'cvFileUrl' | 'aiSummary'
>;

@Injectable()
export class DedupService {
  constructor(private readonly prisma: PrismaService) {}

  async check(candidate: CandidateExtract, tenantId: string, tx?: Prisma.TransactionClient): Promise<DedupCheck> {
    const client = tx ?? this.prisma;

    // Email is the strongest identity key. Case-insensitive: "Snir1603@" and "snir1603@" are one
    // applicant (seen in prod). The DB index is lower(email)-based from migration 20260907000000;
    // the processor's advisory lock on the lower-cased address serialises concurrent spellings.
    const email = normalizeEmail(candidate.email);
    if (email) {
      // Oldest row wins: until the case-insensitive unique index exists (migration 20260907000000
      // WARNING branch), two spellings of one address can coexist — repeated submissions must
      // converge on the same row, not on whichever the planner returns first.
      const emailMatch = await client.candidate.findFirst({
        where: { tenantId, email: { equals: email, mode: 'insensitive' } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (emailMatch) return { outcome: 'match', candidateId: emailMatch.id, field: 'email' };
    }

    // Phone: digit-only compare on both sides; junk (< 7 digits) is "no phone".
    const digits = phoneDigits(candidate.phone);
    if (!digits) return { outcome: 'new', sharedPhoneWith: null };

    const phoneRows = await findCandidatesByPhoneDigits(client, tenantId, digits);
    if (phoneRows.length === 0) return { outcome: 'new', sharedPhoneWith: null };

    const incomingIdentity = emailIdentity(candidate.email);
    if (!incomingIdentity) {
      // No email to disambiguate with. One row → it's them. Several DIFFERENT people on the
      // number (family / agency phone) → we cannot pick; a new row is the honest outcome.
      const distinct = new Set(phoneRows.map((row) => emailIdentity(row.email)).filter(Boolean));
      if (distinct.size > 1) return { outcome: 'new', sharedPhoneWith: phoneRows[0].id };
      return { outcome: 'match', candidateId: phoneRows[0].id, field: 'phone' };
    }

    // D1 email-compatibility guard on EVERY row sharing the phone (oldest first): same phone +
    // a different non-null email = a different person; a null or equal email = compatible.
    const compatible = phoneRows.find((row) => {
      const existingIdentity = emailIdentity(row.email);
      return !existingIdentity || existingIdentity === incomingIdentity;
    });
    if (!compatible) return { outcome: 'new', sharedPhoneWith: phoneRows[0].id };
    return { outcome: 'match', candidateId: compatible.id, field: 'phone' };
  }

  async insertCandidate(
    candidate: CandidateExtract,
    tenantId: string,
    fromEmail: string,
    tx?: Prisma.TransactionClient,
    source?: string | null, // optional source from extraction.source_hint
    enrichment?: CandidateEnrichment,
  ): Promise<string> {
    const client = tx ?? this.prisma;
    const created = await client.candidate.create({
      data: {
        tenantId,
        fullName: candidate.full_name,
        email: candidate.email ?? null,
        phone: candidate.phone ?? null,
        source: source ?? 'direct',
        sourceAgency: candidate.source_agency ?? null,
        sourceEmail: fromEmail,
        // Everything extraction already knows is written NOW. The row used to be a bare shell
        // for the seconds until Phase 7 — or forever, when Phase 7 threw.
        ...(enrichment
          ? {
              currentRole: enrichment.currentRole,
              yearsExperience: enrichment.yearsExperience,
              location: enrichment.location,
              skills: enrichment.skills,
              cvText: enrichment.cvText.trim() ? enrichment.cvText : null,
              cvFileUrl: enrichment.cvFileUrl,
              aiSummary: enrichment.aiSummary,
            }
          : {}),
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * D14: a merged submission must not lose contact data. COALESCE semantics — the existing
   * value wins whenever present; only null/blank fields are filled. Email is filled only when
   * no other row holds it (the caller's advisory lock serialises same-email submissions, this
   * check covers the rest). Returns the fields that were written, for the intake log.
   */
  async fillContactFields(
    candidateId: string,
    candidate: CandidateExtract,
    tenantId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ContactField[]> {
    const client = tx ?? this.prisma;
    const existing = await client.candidate.findUniqueOrThrow({
      where: { id: candidateId },
      select: { email: true, phone: true, fullName: true },
    });

    const data: Prisma.CandidateUncheckedUpdateInput = {};
    const filled: ContactField[] = [];

    const incomingEmail = normalizeEmail(candidate.email);
    if (!normalizeEmail(existing.email) && incomingEmail) {
      const taken = await client.candidate.findFirst({
        where: { tenantId, email: { equals: incomingEmail, mode: 'insensitive' }, NOT: { id: candidateId } },
        select: { id: true },
      });
      if (!taken) {
        data.email = incomingEmail;
        filled.push('email');
      }
    }

    if (!phoneDigits(existing.phone) && phoneDigits(candidate.phone)) {
      data.phone = candidate.phone;
      filled.push('phone');
    }

    if (existing.fullName.trim() === '' && candidate.full_name.trim() !== '') {
      data.fullName = candidate.full_name;
      filled.push('fullName');
    }

    if (filled.length > 0) {
      await client.candidate.update({ where: { id: candidateId }, data });
    }
    return filled;
  }
}
