import { CvClassifierService, CvClassifierInput } from './cv-classifier.service';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../storage/storage.service';
import { generateObject } from 'ai';

jest.mock('ai', () => ({
  generateObject: jest.fn(),
}));

jest.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: jest.fn().mockReturnValue({
    chat: jest.fn().mockReturnValue('mocked-model'),
  }),
}));

const mockGenerateObject = generateObject as jest.MockedFunction<typeof generateObject>;

function makeService(
  storage?: Partial<{ loadClassificationCache: jest.Mock; saveClassificationCache: jest.Mock }>,
): CvClassifierService {
  const configService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'CLASSIFIER_MODEL') return 'openai/gpt-4o-mini';
      return 'fake-openrouter-key';
    }),
  } as unknown as ConfigService;
  const mockStorage = {
    loadClassificationCache: jest.fn().mockResolvedValue(null),
    saveClassificationCache: jest.fn().mockResolvedValue(undefined),
    ...(storage ?? {}),
  } as unknown as StorageService;
  return new CvClassifierService(configService, mockStorage);
}

const BASE_INPUT: CvClassifierInput = {
  fullText: 'some email text',
  subject: 'Test Subject',
  fromEmail: 'test@example.com',
  suspicious: false,
  hasMeaningfulAttachment: false,
  hasCvDocument: false,
  bodyLength: 200,
  resolvedAgency: null,
  tenantId: 'tenant-uuid',
  messageId: 'msg-uuid',
};

describe('CvClassifierService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('short-circuits to "cv" for a known agency sender with an attachment (no AI call)', async () => {
    const service = makeService();
    const result = await service.classify({
      ...BASE_INPUT,
      resolvedAgency: 'jobhunt',
      hasMeaningfulAttachment: true,
      hasCvDocument: true,
    });

    expect(result.verdict).toBe('cv');
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit when a known agency sender has no attachment (falls through to AI)', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: { verdict: 'uncertain', reason: 'no document' } } as any);
    const service = makeService();

    await service.classify({ ...BASE_INPUT, resolvedAgency: 'jobhunt', hasMeaningfulAttachment: false, hasCvDocument: false });

    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
  });

  it.each(['cv', 'not_cv', 'uncertain'] as const)('returns the AI verdict "%s" verbatim', async (verdict) => {
    mockGenerateObject.mockResolvedValueOnce({ object: { verdict, reason: 'because' } } as any);
    const service = makeService();

    const result = await service.classify(BASE_INPUT);

    expect(result).toEqual({ verdict, reason: 'because' });
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
  });

  it('returns the cached verdict without calling AI on a cache hit', async () => {
    const service = makeService({
      loadClassificationCache: jest.fn().mockResolvedValue({ verdict: 'not_cv', reason: 'cached invoice' }),
    });

    const result = await service.classify(BASE_INPUT);

    expect(result).toEqual({ verdict: 'not_cv', reason: 'cached invoice' });
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it('propagates AI errors so BullMQ retries', async () => {
    mockGenerateObject.mockRejectedValueOnce(new Error('Network timeout'));
    const service = makeService();

    await expect(service.classify(BASE_INPUT)).rejects.toThrow('Network timeout');
  });

  it('caches the verdict after a successful AI call', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: { verdict: 'cv', reason: 'looks like a resume' } } as any);
    const saveClassificationCache = jest.fn().mockResolvedValue(undefined);
    const service = makeService({ saveClassificationCache });

    await service.classify(BASE_INPUT);

    expect(saveClassificationCache).toHaveBeenCalledWith(
      { verdict: 'cv', reason: 'looks like a resume' },
      'tenant-uuid',
      'msg-uuid',
    );
  });

  it('still returns the verdict when caching fails (soft-fail)', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: { verdict: 'cv', reason: 'resume' } } as any);
    const service = makeService({
      saveClassificationCache: jest.fn().mockRejectedValue(new Error('R2 down')),
    });

    const result = await service.classify(BASE_INPUT);

    expect(result.verdict).toBe('cv');
  });

  it('passes the clues (attachment, suspicious, agency) into the AI prompt', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: { verdict: 'cv', reason: 'r' } } as any);
    const service = makeService();

    await service.classify({
      ...BASE_INPUT,
      subject: 'Presenting candidate',
      fromEmail: 'talent@jobhunt.co.il',
      suspicious: true,
      // false on purpose: agency + attachment would trip the Layer-1 short-circuit
      // (see the first test), so the AI is never called. We need the AI path here
      // to assert the clues land in the prompt — the resolved agency still appears.
      hasMeaningfulAttachment: false,
      hasCvDocument: false,
      resolvedAgency: 'jobhunt',
    });

    const callArg = mockGenerateObject.mock.calls[0][0] as any;
    expect(callArg.prompt).toContain('Subject: Presenting candidate');
    expect(callArg.prompt).toContain('From: talent@jobhunt.co.il');
    expect(callArg.prompt).toContain('Resolved recruiting agency: jobhunt');
    expect(callArg.temperature).toBe(0);
    expect(callArg.maxRetries).toBe(1);
    expect(callArg.abortSignal).toBeInstanceOf(AbortSignal);
    expect(callArg.model).toBe('mocked-model');
  });
  it('does NOT short-circuit a known agency whose only attachment is a logo', async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: { verdict: 'not_cv', reason: 'newsletter' } } as any);
    const service = makeService();

    const result = await service.classify({
      ...BASE_INPUT,
      resolvedAgency: 'AllJobs',
      hasMeaningfulAttachment: true,
      hasCvDocument: false,
    });

    expect(result.verdict).toBe('not_cv');
    expect(mockGenerateObject).toHaveBeenCalled();
  });
});
