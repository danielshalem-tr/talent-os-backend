import { BulkAssignSchema } from './bulk-assign.dto';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('BulkAssignSchema', () => {
  it('accepts a valid body', () => {
    expect(BulkAssignSchema.safeParse({ candidate_ids: [uuid(1)], job_id: uuid(2) }).success).toBe(true);
  });

  it('rejects an empty candidate list', () => {
    expect(BulkAssignSchema.safeParse({ candidate_ids: [], job_id: uuid(2) }).success).toBe(false);
  });

  it('rejects more than 200 candidates', () => {
    const ids = Array.from({ length: 201 }, (_, i) => uuid(i + 1));
    expect(BulkAssignSchema.safeParse({ candidate_ids: ids, job_id: uuid(999) }).success).toBe(false);
  });

  it('accepts exactly 200 candidates', () => {
    const ids = Array.from({ length: 200 }, (_, i) => uuid(i + 1));
    expect(BulkAssignSchema.safeParse({ candidate_ids: ids, job_id: uuid(999) }).success).toBe(true);
  });

  it('rejects a non-UUID id', () => {
    expect(BulkAssignSchema.safeParse({ candidate_ids: ['not-a-uuid'], job_id: uuid(2) }).success).toBe(false);
  });
});
