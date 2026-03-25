import { CreateJobSchema, HiringStageCreateSchema, ScreeningQuestionCreateSchema } from './create-job.dto';

describe('CreateJobSchema', () => {
  it('accepts { title: "Eng" } — title is the only required field', () => {
    const result = CreateJobSchema.parse({ title: 'Eng' });
    expect(result.title).toBe('Eng');
  });

  it('throws ZodError when title is missing', () => {
    expect(() => CreateJobSchema.parse({})).toThrow();
  });

  it('throws ZodError with "Job title required" when title is empty string', () => {
    expect(() => CreateJobSchema.parse({ title: '' })).toThrow('Job title required');
  });

  it('accepts hiring_flow array with name, order, color, is_enabled', () => {
    const result = CreateJobSchema.parse({
      title: 'Eng',
      hiring_flow: [{ name: 'Review', order: 1, color: 'bg-zinc-400', is_enabled: true, is_custom: false }],
    });
    expect(result.hiring_flow).toHaveLength(1);
    expect(result.hiring_flow![0].name).toBe('Review');
  });

  it('inferred type has hiring_flow as optional array', () => {
    const result = CreateJobSchema.parse({ title: 'Eng' });
    expect(result.hiring_flow).toBeUndefined();
  });

  it('accepts screening_questions with valid type', () => {
    const result = CreateJobSchema.parse({
      title: 'Eng',
      screening_questions: [{ text: 'Q?', type: 'yes_no' }],
    });
    expect(result.screening_questions).toHaveLength(1);
  });

  it('throws ZodError for invalid screening question type', () => {
    expect(() =>
      CreateJobSchema.parse({
        title: 'Eng',
        screening_questions: [{ text: 'Q?', type: 'invalid' }],
      }),
    ).toThrow();
  });

  it('rejects if all hiring_flow stages have is_enabled=false', () => {
    expect(() =>
      CreateJobSchema.parse({
        title: 'Eng',
        hiring_flow: [{ name: 'S1', order: 1, color: 'bg-zinc-400', is_enabled: false, is_custom: false }],
      }),
    ).toThrow('At least one hiring stage must be enabled');
  });

  it('accepts if at least one stage is enabled', () => {
    const result = CreateJobSchema.parse({
      title: 'Eng',
      hiring_flow: [
        { name: 'S1', order: 1, color: 'bg-zinc-400', is_enabled: false, is_custom: false },
        { name: 'S2', order: 2, color: 'bg-blue-500', is_enabled: true, is_custom: false },
      ],
    });
    expect(result.hiring_flow).toHaveLength(2);
  });

  it('defaults job_type to full_time and status to draft', () => {
    const result = CreateJobSchema.parse({ title: 'Eng' });
    expect(result.job_type).toBe('full_time');
    expect(result.status).toBe('draft');
  });

  it('defaults must_have_skills, nice_to_have_skills, selected_org_types to empty arrays', () => {
    const result = CreateJobSchema.parse({ title: 'Eng' });
    expect(result.must_have_skills).toEqual([]);
    expect(result.nice_to_have_skills).toEqual([]);
    expect(result.selected_org_types).toEqual([]);
  });
});

describe('HiringStageCreateSchema', () => {
  it('accepts name, order, color, is_enabled, is_custom', () => {
    const result = HiringStageCreateSchema.parse({
      name: 'Review',
      order: 1,
      color: 'bg-zinc-400',
      is_enabled: true,
      is_custom: false,
    });
    expect(result.name).toBe('Review');
    expect(result.is_custom).toBe(false);
    expect(result.is_enabled).toBe(true);
    expect(result.color).toBe('bg-zinc-400');
  });

  it('accepts nullable interviewer', () => {
    const result = HiringStageCreateSchema.parse({ name: 'Review', order: 1, color: 'bg-zinc-400', interviewer: null });
    expect(result.interviewer).toBeNull();
  });

  it('accepts free text string for interviewer (not UUID-validated)', () => {
    const result = HiringStageCreateSchema.parse({
      name: 'Review',
      order: 1,
      color: 'bg-zinc-400',
      interviewer: 'John Smith (not a UUID)',
    });
    expect(result.interviewer).toBe('John Smith (not a UUID)');
  });

  it('defaults is_enabled to true and is_custom to false', () => {
    const result = HiringStageCreateSchema.parse({ name: 'Review', order: 1, color: 'bg-zinc-400' });
    expect(result.is_enabled).toBe(true);
    expect(result.is_custom).toBe(false);
  });
});

describe('ScreeningQuestionCreateSchema', () => {
  it('accepts valid type values: yes_no and text', () => {
    for (const type of ['yes_no', 'text']) {
      expect(() => ScreeningQuestionCreateSchema.parse({ text: 'Q?', type })).not.toThrow();
    }
  });

  it('rejects invalid type', () => {
    expect(() => ScreeningQuestionCreateSchema.parse({ text: 'Q?', type: 'invalid' })).toThrow();
  });

  it('accepts optional expected_answer field', () => {
    const result = ScreeningQuestionCreateSchema.parse({
      text: 'React experience?',
      type: 'yes_no',
      expected_answer: 'yes',
    });
    expect(result.expected_answer).toBe('yes');
  });

  it('accepts null expected_answer', () => {
    const result = ScreeningQuestionCreateSchema.parse({ text: 'Q?', type: 'text', expected_answer: null });
    expect(result.expected_answer).toBeNull();
  });
});
