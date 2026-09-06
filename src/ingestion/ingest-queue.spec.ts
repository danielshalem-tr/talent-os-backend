import { INGEST_JOB_OPTS, ingestJobId, ingestReplayJobId } from './ingest-queue';

describe('ingest-queue identities', () => {
  it('is deterministic per (tenant, message) and never contains a colon', () => {
    const a = ingestJobId('t1', '<weird:id/with spaces@example.com>');
    expect(a).toBe(ingestJobId('t1', '<weird:id/with spaces@example.com>'));
    expect(a).not.toBe(ingestJobId('t2', '<weird:id/with spaces@example.com>'));
    expect(a).toMatch(/^intake-[0-9a-f]{32}$/);
    expect(a.includes(':')).toBe(false);
  });

  it('replay ids differ from the base id and from each other', () => {
    const base = ingestJobId('t1', 'm');
    expect(ingestReplayJobId('t1', 'm', 1)).toBe(`${base}-replay-1`);
    expect(ingestReplayJobId('t1', 'm', 2)).not.toBe(ingestReplayJobId('t1', 'm', 1));
  });

  it('retries five times, exponential from 30 s', () => {
    expect(INGEST_JOB_OPTS).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 500 },
    });
  });
});
