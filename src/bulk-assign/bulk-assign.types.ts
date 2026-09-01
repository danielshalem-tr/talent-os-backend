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
