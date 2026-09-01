jest.mock('ai', () => ({ generateObject: jest.fn() }));
import { generateObject } from 'ai';
import { ConfigService } from '@nestjs/config';
import { renderAssessment, VoiceAssessmentService } from './voice-assessment.service';

const mockGenerateObject = generateObject as jest.MockedFunction<typeof generateObject>;

function makeConfig(): ConfigService {
  const values: Record<string, string> = { OPENROUTER_API_KEY: 'test-key' };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const ASSESSMENT = {
  answers: [
    { question: 'Are you legally allowed to work in Israel?', answer: 'Yes.', flags: [] },
    { question: 'How many years of React?', answer: '—', flags: ['not_answered'] },
  ],
  recommendation: 'Review — the React-experience question was never answered.',
};

describe('renderAssessment', () => {
  it('renders the header, every question (flagged ones included) and the recommendation', () => {
    const text = renderAssessment(ASSESSMENT as never, { attempt: 1, durationSecs: 241 });
    expect(text).toBe(
      '[AI screening-call assessment — attempt 1, 4 min]\n' +
        '\n' +
        '1. Are you legally allowed to work in Israel?\n' +
        '   Answer: Yes.\n' +
        '2. How many years of React?\n' +
        '   Answer: —\n' +
        '   Flags: not actually answered\n' +
        '\n' +
        'Recommendation: Review — the React-experience question was never answered.',
    );
  });

  it('omits the duration when unknown', () => {
    const text = renderAssessment(ASSESSMENT as never, { attempt: 2, durationSecs: null });
    expect(text.startsWith('[AI screening-call assessment — attempt 2]\n')).toBe(true);
  });
});

describe('VoiceAssessmentService.generateAssessment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateObject.mockResolvedValue({ object: ASSESSMENT } as never);
  });

  it('sends numbered questions + labeled transcript turns at temperature 0, returns rendered text', async () => {
    const svc = new VoiceAssessmentService({} as never, makeConfig());
    const text = await svc.generateAssessment({
      transcript: [
        { role: 'agent', message: 'שלום, יש כמה רגעים?' },
        { role: 'user', message: 'כן, בטח' },
      ],
      questions: [{ text: 'X' }, { text: 'Y' }],
      attempt: 1,
      durationSecs: 241,
    });
    const call = mockGenerateObject.mock.calls[0][0] as Record<string, unknown>;
    expect(call.prompt).toContain('1. X\n2. Y');
    expect(call.prompt).toContain('Interviewer: שלום, יש כמה רגעים?');
    expect(call.prompt).toContain('Candidate: כן, בטח');
    expect(call.temperature).toBe(0);
    expect(text).toContain('[AI screening-call assessment — attempt 1, 4 min]');
    expect(text).toContain('How many years of React?');
  });

  it('propagates LLM/schema failures — nothing is swallowed here', async () => {
    mockGenerateObject.mockRejectedValue(new Error('response did not match schema'));
    const svc = new VoiceAssessmentService({} as never, makeConfig());
    await expect(
      svc.generateAssessment({ transcript: [], questions: [], attempt: 1, durationSecs: null }),
    ).rejects.toThrow('response did not match schema');
  });
});
