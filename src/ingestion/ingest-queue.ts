import { createHash } from 'crypto';
import type { JobsOptions } from 'bullmq';

export const INGEST_QUEUE_NAME = 'ingest-email';
export const INGEST_JOB_NAME = 'ingest-email';

/**
 * Five attempts, exponential from 30 s: 30 s → 1 min → 2 min → 4 min ≈ 7.5 min in total —
 * enough to ride out a provider blip. The classification/extraction/matching R2 caches make the
 * AI-free part of a retry cheap. An outage that outlives this parks the row in `held` (see
 * IngestionProcessor) for one-click replay. Shared by the webhook AND ingest-control so the two
 * enqueue paths cannot drift again.
 */
export const INGEST_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 500 },
};

/**
 * BullMQ 5 rejects custom ids that contain ':' (unless exactly three segments) and a raw
 * Message-Id can contain anything. Hashing makes the id safe AND deterministic per
 * (tenant, message), so a Mailgun redelivery dedupes against the original job.
 */
export function ingestJobId(tenantId: string, messageId: string): string {
  return `intake-${createHash('sha256').update(`${tenantId}\n${messageId}`).digest('hex').slice(0, 32)}`;
}

/** A fresh id for a deliberate re-run (ingest-control replay, or redelivery after a completed run). */
export function ingestReplayJobId(tenantId: string, messageId: string, now: number = Date.now()): string {
  return `${ingestJobId(tenantId, messageId)}-replay-${now}`;
}
