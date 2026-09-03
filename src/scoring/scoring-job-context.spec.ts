import { toScoringJob, scoringJobSelect } from './scoring-job-context';

describe('scoring-job-context', () => {
  it('selects every field the scorer needs and never the legacy requirements column', () => {
    expect(scoringJobSelect).toMatchObject({
      title: true,
      description: true,
      roleSummary: true,
      responsibilities: true,
      mustHaveSkills: true,
      niceToHaveSkills: true,
      expYearsMin: true,
      expYearsMax: true,
      preferredOrgTypes: true,
      screeningQuestions: { select: { text: true } },
    });
    expect((scoringJobSelect as Record<string, unknown>).requirements).toBeUndefined();
  });

  it('flattens screening questions to their text and defaults arrays', () => {
    const job = toScoringJob({
      title: 'Full Stack Developer',
      description: 'desc',
      roleSummary: null,
      responsibilities: null,
      mustHaveSkills: ['React'],
      niceToHaveSkills: [],
      expYearsMin: 1,
      expYearsMax: 5,
      preferredOrgTypes: ['startup'],
      screeningQuestions: [{ text: 'Used Claude Code?' }],
    });
    expect(job).toEqual({
      title: 'Full Stack Developer',
      description: 'desc',
      roleSummary: null,
      responsibilities: null,
      mustHaveSkills: ['React'],
      niceToHaveSkills: [],
      expYearsMin: 1,
      expYearsMax: 5,
      preferredOrgTypes: ['startup'],
      screeningQuestions: ['Used Claude Code?'],
    });
  });
});
