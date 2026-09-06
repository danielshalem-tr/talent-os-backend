import { Prisma } from '@prisma/client';
import { mergeEnrichment, EnrichmentFields } from '../ingestion/merge-enrichment';
import { ContactBlocklist, isBlockedPhone } from './contact-blocklist';
import { normalizeEmail, phoneDigits } from './contact-normalize';

// ─── Planning (pure) ──────────────────────────────────────────────────────────

export interface MergeCandidateRow {
  id: string;
  email: string | null;
  phone: string | null;
  createdAt: Date;
}

export interface MergePlan {
  /** Oldest row per phone survives; each newer, email-compatible row merges into it. */
  merges: Array<{ survivorId: string; removedId: string; digits: string }>;
  /** Same phone, different non-null email (D1): two people — reported, never merged. */
  shared: Array<{ survivorId: string; otherId: string; digits: string }>;
}

/**
 * Same rules as the live intake path (DedupService.check): digit-only phone compare, junk and
 * blocklisted phones ignored, D1 email guard. The survivor's email is tracked as it would be
 * AFTER each planned merge, so "null then a@x then b@x" merges a@x and reports b@x as shared.
 */
export function planPhoneMerges(rows: MergeCandidateRow[], blocklist: ContactBlocklist): MergePlan {
  const groups = new Map<string, MergeCandidateRow[]>();
  for (const row of rows) {
    const digits = phoneDigits(row.phone);
    if (!digits || isBlockedPhone(row.phone, blocklist)) continue;
    const group = groups.get(digits) ?? [];
    group.push(row);
    groups.set(digits, group);
  }

  const plan: MergePlan = { merges: [], shared: [] };
  for (const [digits, group] of groups) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const survivor = ordered[0];
    let survivorEmail = normalizeEmail(survivor.email);
    for (const row of ordered.slice(1)) {
      const email = normalizeEmail(row.email);
      if (email && survivorEmail && email !== survivorEmail) {
        plan.shared.push({ survivorId: survivor.id, otherId: row.id, digits });
        continue;
      }
      plan.merges.push({ survivorId: survivor.id, removedId: row.id, digits });
      if (!survivorEmail && email) survivorEmail = email;
    }
  }
  return plan;
}

// ─── Execution (one transaction, DB-only) ─────────────────────────────────────

export interface MergeLog {
  survivor: string;
  removed: string;
  fields: string[];
  moved: { applications: number; intakeLogs: number; voiceCalls: number; summaries: number };
}

const candidateMergeSelect = {
  id: true,
  tenantId: true,
  email: true,
  phone: true,
  fullName: true,
  jobId: true,
  hiringStageId: true,
  currentRole: true,
  yearsExperience: true,
  location: true,
  skills: true,
  cvText: true,
  cvFileUrl: true,
  aiSummary: true,
  aiScore: true,
  isScoreOverridden: true,
  createdAt: true,
} satisfies Prisma.CandidateSelect;

const scoreSelect = {
  id: true,
  score: true,
  reasoning: true,
  strengths: true,
  gaps: true,
  breakdown: true,
  modelUsed: true,
  matchConfidence: true,
} satisfies Prisma.CandidateJobScoreSelect;

const applicationMergeSelect = {
  id: true,
  jobId: true,
  jobStageId: true,
  scores: { select: scoreSelect },
} satisfies Prisma.ApplicationSelect;

type CandidateMergeRow = Prisma.CandidateGetPayload<{ select: typeof candidateMergeSelect }>;

function toEnrichment(row: CandidateMergeRow): EnrichmentFields {
  return {
    jobId: row.jobId,
    hiringStageId: row.hiringStageId,
    currentRole: row.currentRole,
    yearsExperience: row.yearsExperience,
    location: row.location,
    skills: row.skills,
    cvText: row.cvText ?? '',
    cvFileUrl: row.cvFileUrl,
    aiSummary: row.aiSummary,
  };
}

/**
 * Fold `removedId` into `survivorId`. MUST run inside a `$transaction` (the caller passes `tx`)
 * — every child table is re-pointed and the removed row deleted atomically:
 *
 *  1. applications → re-pointed; on idx_applications_unique conflict the survivor's application
 *     stays, the higher candidate_job_scores row wins (copied onto the survivor's score row, or
 *     the loser's row re-keyed when the survivor has none), the loser's application is deleted.
 *  2. email_intake_log.candidate_id (FK SetNull — would otherwise orphan) and voice_calls → re-pointed.
 *  3. candidate_stage_summaries → re-pointed; on idx_cand_stage_summary conflict the survivor's wins.
 *  4. duplicate_flags referencing the removed row (both FKs RESTRICT) deleted, then the row.
 *  5. survivor: enrichment via the SAME rule as intake Phase 7 (mergeEnrichment — newer wins when
 *     non-empty), contact fields COALESCE'd (existing wins), job pointer from the removed row only
 *     if the survivor had none (D9), aiScore = max unless a recruiter override is sticky. The email
 *     is written AFTER the delete so idx_candidates_tenant_email_unique cannot fire.
 */
export async function mergeCandidates(
  tx: Prisma.TransactionClient,
  params: { tenantId: string; survivorId: string; removedId: string },
): Promise<MergeLog> {
  const { tenantId, survivorId, removedId } = params;
  if (survivorId === removedId) throw new Error('survivor and removed must differ');

  const [survivor, removed] = await Promise.all([
    tx.candidate.findFirstOrThrow({ where: { id: survivorId, tenantId }, select: candidateMergeSelect }),
    tx.candidate.findFirstOrThrow({ where: { id: removedId, tenantId }, select: candidateMergeSelect }),
  ]);

  // 1. Applications (+ scores)
  const [survivorApps, removedApps] = await Promise.all([
    tx.application.findMany({ where: { candidateId: survivorId }, select: applicationMergeSelect }),
    tx.application.findMany({ where: { candidateId: removedId }, select: applicationMergeSelect }),
  ]);
  const survivorByJob = new Map(survivorApps.map((a) => [a.jobId, a]));
  let movedApplications = 0;
  for (const app of removedApps) {
    const keep = survivorByJob.get(app.jobId);
    if (!keep) {
      await tx.application.update({ where: { id: app.id }, data: { candidateId: survivorId } });
      movedApplications += 1;
      continue;
    }
    const loserScore = app.scores[0];
    const keepScore = keep.scores[0];
    if (loserScore && (!keepScore || loserScore.score > keepScore.score)) {
      if (keepScore) {
        await tx.candidateJobScore.update({
          where: { id: keepScore.id },
          data: {
            score: loserScore.score,
            reasoning: loserScore.reasoning,
            strengths: loserScore.strengths,
            gaps: loserScore.gaps,
            modelUsed: loserScore.modelUsed,
            matchConfidence: loserScore.matchConfidence,
            ...(loserScore.breakdown !== null ? { breakdown: loserScore.breakdown as Prisma.InputJsonValue } : {}),
          },
        });
      } else {
        await tx.candidateJobScore.update({ where: { id: loserScore.id }, data: { applicationId: keep.id } });
      }
    }
    if (keep.jobStageId === null && app.jobStageId !== null) {
      await tx.application.update({ where: { id: keep.id }, data: { jobStageId: app.jobStageId } });
    }
    await tx.application.delete({ where: { id: app.id } }); // cascades whatever score row is still attached
  }

  // 2. Intake logs + voice calls
  const intakeLogs = await tx.emailIntakeLog.updateMany({
    where: { candidateId: removedId },
    data: { candidateId: survivorId },
  });
  const voiceCalls = await tx.voiceCall.updateMany({
    where: { candidateId: removedId },
    data: { candidateId: survivorId },
  });

  // 3. Stage summaries — unique per (candidate, stage); the survivor's note wins
  const [survivorSummaries, removedSummaries] = await Promise.all([
    tx.candidateStageSummary.findMany({ where: { candidateId: survivorId }, select: { id: true, jobStageId: true } }),
    tx.candidateStageSummary.findMany({ where: { candidateId: removedId }, select: { id: true, jobStageId: true } }),
  ]);
  const survivorStageIds = new Set(survivorSummaries.map((s) => s.jobStageId));
  let movedSummaries = 0;
  for (const summary of removedSummaries) {
    if (survivorStageIds.has(summary.jobStageId)) {
      await tx.candidateStageSummary.delete({ where: { id: summary.id } });
    } else {
      await tx.candidateStageSummary.update({ where: { id: summary.id }, data: { candidateId: survivorId } });
      movedSummaries += 1;
    }
  }

  // 4. Flags (RESTRICT FKs), then the row itself
  await tx.duplicateFlag.deleteMany({
    where: { OR: [{ candidateId: removedId }, { matchedCandidateId: removedId }] },
  });
  await tx.candidate.delete({ where: { id: removedId } });

  // 5. Survivor fields
  const enriched = mergeEnrichment(toEnrichment(survivor), toEnrichment(removed));
  const data: Prisma.CandidateUncheckedUpdateInput = {
    currentRole: enriched.currentRole,
    yearsExperience: enriched.yearsExperience,
    location: enriched.location,
    skills: enriched.skills,
    cvText: enriched.cvText === '' ? null : enriched.cvText,
    cvFileUrl: enriched.cvFileUrl,
    aiSummary: enriched.aiSummary,
    // D9 / spec §3.2: the pointer moves only when the survivor had none.
    jobId: survivor.jobId ?? removed.jobId,
    hiringStageId: survivor.jobId ? survivor.hiringStageId : removed.hiringStageId,
  };
  if (!survivor.isScoreOverridden) {
    const best = Math.max(survivor.aiScore ?? -1, removed.aiScore ?? -1);
    data.aiScore = best === -1 ? null : best;
  }
  if (!normalizeEmail(survivor.email) && normalizeEmail(removed.email)) data.email = removed.email;
  if (!phoneDigits(survivor.phone) && phoneDigits(removed.phone)) data.phone = removed.phone;
  if (survivor.fullName.trim() === '' && removed.fullName.trim() !== '') data.fullName = removed.fullName;

  await tx.candidate.update({ where: { id: survivorId }, data });

  const fields = Object.keys(data).filter((key) => {
    const before = (survivor as Record<string, unknown>)[key];
    const after = (data as Record<string, unknown>)[key];
    return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
  });

  return {
    survivor: survivorId,
    removed: removedId,
    fields,
    moved: {
      applications: movedApplications,
      intakeLogs: intakeLogs.count,
      voiceCalls: voiceCalls.count,
      summaries: movedSummaries,
    },
  };
}
