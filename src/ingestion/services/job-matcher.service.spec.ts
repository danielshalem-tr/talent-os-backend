import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { JobMatcherService, JobMatcherInput } from './job-matcher.service';

jest.mock('ai', () => ({ generateText: jest.fn(), Output: { object: jest.fn((spec: unknown) => spec) } }));
jest.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: jest.fn().mockReturnValue({ chat: jest.fn().mockReturnValue('model-handle') }),
}));

const generateTextMock = generateText as unknown as jest.Mock;

const baseInput: JobMatcherInput = {
  openJobs: [
    { shortId: '106', title: 'Full Stack Developer', department: 'Engineering' },
    { shortId: '107', title: 'Product Manager', department: 'Product' },
  ],
  emailSubject: 'Application - Full Stack Developer',
  emailBody: 'Please find my CV attached.',
  currentRole: 'Full Stack Developer',
};

describe('JobMatcherService', () => {
  let service: JobMatcherService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobMatcherService,
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('test-key') } },
      ],
    }).compile();
    service = module.get(JobMatcherService);
  });

  it('returns the matched short_ids', async () => {
    generateTextMock.mockResolvedValue({ output: { short_ids: ['106'] } });
    await expect(service.match(baseInput)).resolves.toEqual(['106']);
  });

  it('calls the model with a deadline and a single SDK retry', async () => {
    generateTextMock.mockResolvedValue({ output: { short_ids: ['106'] } });
    await service.match(baseInput);
    const callArg = generateTextMock.mock.calls[0][0];
    expect(callArg.maxRetries).toBe(1);
    expect(callArg.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('drops ids that are not in the open-job list', async () => {
    generateTextMock.mockResolvedValue({ output: { short_ids: ['106', '999'] } });
    await expect(service.match(baseInput)).resolves.toEqual(['106']);
  });

  it('de-duplicates repeated ids', async () => {
    generateTextMock.mockResolvedValue({ output: { short_ids: ['106', '106'] } });
    await expect(service.match(baseInput)).resolves.toEqual(['106']);
  });

  it('returns an empty array when the model declines to guess', async () => {
    generateTextMock.mockResolvedValue({ output: { short_ids: [] } });
    await expect(service.match(baseInput)).resolves.toEqual([]);
  });

  it('returns an empty array instead of throwing when the call fails', async () => {
    generateTextMock.mockRejectedValue(new Error('openrouter 503'));
    await expect(service.match(baseInput)).resolves.toEqual([]);
  });

  it('does not call the model when there are no open jobs', async () => {
    await expect(service.match({ ...baseInput, openJobs: [] })).resolves.toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
