export const BULK_ASSIGN_QUEUE = 'candidate-assign';

export interface AssignJobData {
  tenantId: string;
  candidateId: string;
  jobId: string;
}

// Shared BullMQ enqueue options (mirrors voice-calls.service.ts VOICE_JOB_OPTS).
export const ASSIGN_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 500 },
};

/** How long a repeat enqueue for the same (candidate, job) collapses into the first one. */
export const ASSIGN_DEDUP_TTL_MS = 60_000;

/**
 * Collapse a double-click without ever blocking a genuine re-assign.
 *
 * A stable `jobId` cannot do this. BullMQ skips an `add` whose job id still exists in ANY
 * set, and `removeOnComplete/removeOnFail: { count }` keep finished ids around for hundreds
 * of jobs — so re-assigning the same pair minutes later silently did nothing while the API
 * still answered `{ queued: n }`, and a pair that exhausted its attempts stayed blocked
 * until 500 newer failures evicted it. A deduplication key expires on its own, which is the
 * behaviour PROTOCOL.md promises ("re-sending the same body re-runs scoring").
 */
export function assignJobOpts(candidateId: string, jobId: string) {
  return {
    ...ASSIGN_JOB_OPTS,
    deduplication: { id: `assign-${candidateId}-${jobId}`, ttl: ASSIGN_DEDUP_TTL_MS },
  };
}
