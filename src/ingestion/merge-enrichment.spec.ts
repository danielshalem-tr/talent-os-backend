import { mergeEnrichment, EnrichmentFields } from './merge-enrichment';

const empty: EnrichmentFields = {
  jobId: null,
  hiringStageId: null,
  currentRole: null,
  yearsExperience: null,
  location: null,
  skills: [],
  cvText: '',
  cvFileUrl: null,
  aiSummary: null,
};

const rich: EnrichmentFields = {
  jobId: 'job-1',
  hiringStageId: 'stage-1',
  currentRole: 'Backend Developer',
  yearsExperience: 6,
  location: 'Tel Aviv, Israel',
  skills: ['node.js'],
  cvText: 'full cv text',
  cvFileUrl: 'r2/key.pdf',
  aiSummary: 'A summary.',
};

describe('mergeEnrichment', () => {
  it('writes everything for a brand-new candidate', () => {
    expect(mergeEnrichment(empty, rich)).toEqual(rich);
  });

  it('keeps existing values when the repeat submission carries nothing', () => {
    expect(mergeEnrichment(rich, empty)).toEqual(rich);
  });

  it('lets a non-empty incoming value win', () => {
    const incoming = { ...empty, location: 'Haifa, Israel' };
    expect(mergeEnrichment(rich, incoming).location).toBe('Haifa, Israel');
  });

  it('never blanks a job assignment when no job matched this time', () => {
    const merged = mergeEnrichment(rich, empty);
    expect(merged.jobId).toBe('job-1');
    expect(merged.hiringStageId).toBe('stage-1');
  });

  it('takes the new stage together with the new job', () => {
    const incoming = { ...empty, jobId: 'job-2', hiringStageId: 'stage-2' };
    const merged = mergeEnrichment(rich, incoming);
    expect(merged.jobId).toBe('job-2');
    expect(merged.hiringStageId).toBe('stage-2');
  });

  it('keeps existing skills and cv text when the new email has none', () => {
    const merged = mergeEnrichment(rich, { ...empty, cvText: '   ' });
    expect(merged.skills).toEqual(['node.js']);
    expect(merged.cvText).toBe('full cv text');
  });
});
