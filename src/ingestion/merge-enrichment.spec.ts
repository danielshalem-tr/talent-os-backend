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

  it('never resets the stage when the SAME job matches again', () => {
    // A follow-up email quoting the same ad re-resolves to job-1, and Phase 15 always
    // offers that job's FIRST stage. An advanced candidate must keep the stage they are on.
    const advanced = { ...rich, hiringStageId: 'stage-interview' };
    const incoming = { ...empty, jobId: 'job-1', hiringStageId: 'stage-1' };

    const merged = mergeEnrichment(advanced, incoming);

    expect(merged.jobId).toBe('job-1');
    expect(merged.hiringStageId).toBe('stage-interview');
  });

  it('places the first stage when an unassigned candidate gets their first job', () => {
    const incoming = { ...empty, jobId: 'job-1', hiringStageId: 'stage-1' };
    const merged = mergeEnrichment({ ...empty, cvText: 'cv' }, incoming);
    expect(merged.hiringStageId).toBe('stage-1');
  });

  it('keeps existing skills and cv text when the new email has none', () => {
    const merged = mergeEnrichment(rich, { ...empty, cvText: '   ' });
    expect(merged.skills).toEqual(['node.js']);
    expect(merged.cvText).toBe('full cv text');
  });
  describe('CV replacement rule', () => {
    const rich = {
      jobId: null,
      hiringStageId: null,
      currentRole: 'Dev',
      yearsExperience: 5,
      location: null,
      skills: ['ts'],
      cvText: 'FULL CV TEXT '.repeat(50),
      cvFileUrl: 'cvs/t/old.pdf',
      aiSummary: 'x',
    };
    const thin = { ...rich, cvText: '--- Email Body ---\nattaching again', cvFileUrl: 'cvs/t/new.pdf', skills: [] };

    it('a thin follow-up WITHOUT a document keeps the existing CV text AND file', () => {
      const out = mergeEnrichment(rich, thin, { cvFromDocument: false });
      expect(out.cvText).toBe(rich.cvText);
      expect(out.cvFileUrl).toBe('cvs/t/old.pdf');
    });

    it('a new document replaces text and file together', () => {
      const out = mergeEnrichment(rich, { ...thin, cvText: 'NEW CV TEXT' }, { cvFromDocument: true });
      expect(out.cvText).toBe('NEW CV TEXT');
      expect(out.cvFileUrl).toBe('cvs/t/new.pdf');
    });

    it('body-only text fills an EMPTY slot (first application pasted in the body)', () => {
      const out = mergeEnrichment(
        { ...rich, cvText: '', cvFileUrl: null },
        { ...thin, cvFileUrl: null },
        { cvFromDocument: false },
      );
      expect(out.cvText).toBe(thin.cvText);
      expect(out.cvFileUrl).toBeNull();
    });

    it('the SAME document re-sent with a new covering note keeps text, file and profile (score reuse)', () => {
      const doc = 'FULL CV TEXT '.repeat(50).trim();
      const existing = { ...rich, cvText: `--- Email Body ---\nfirst note\n\n${doc}` };
      const resent = {
        ...thin,
        cvText: `--- Email Body ---\nsecond note, interested in Backend Engineer\n\n${doc}`,
        currentRole: 'Backend Engineer',
      };
      const out = mergeEnrichment(existing, resent, { cvFromDocument: true, documentText: doc });
      expect(out.cvText).toBe(existing.cvText);
      expect(out.cvFileUrl).toBe('cvs/t/old.pdf');
      expect(out.currentRole).toBe('Dev');
    });

    it('a body-only follow-up never overwrites CV-derived profile fields, only fills empty ones', () => {
      const note = {
        ...thin,
        currentRole: 'Backend Engineer',
        yearsExperience: 1,
        location: 'Haifa',
        aiSummary: 'note',
      };
      const out = mergeEnrichment({ ...rich, location: null }, note, { cvFromDocument: false });
      expect(out.currentRole).toBe('Dev');
      expect(out.yearsExperience).toBe(5);
      expect(out.skills).toEqual(['ts']);
      expect(out.aiSummary).toBe('x');
      expect(out.location).toBe('Haifa');
    });

    it('a NEW document updates the profile fields', () => {
      const out = mergeEnrichment(
        rich,
        { ...thin, cvText: 'NEW CV TEXT', currentRole: 'Lead' },
        { cvFromDocument: true, documentText: 'NEW CV TEXT' },
      );
      expect(out.currentRole).toBe('Lead');
    });

    it('defaults to the document rule (mergeCandidates callers unchanged)', () => {
      expect(mergeEnrichment(rich, { ...thin, cvText: 'NEW' }).cvText).toBe('NEW');
    });
  });
});
