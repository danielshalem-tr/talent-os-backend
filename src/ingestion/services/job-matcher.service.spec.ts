import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { generateObject } from 'ai';
import { JobMatcherService, JobMatcherInput } from './job-matcher.service';

jest.mock('ai', () => ({ generateObject: jest.fn() }));
jest.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: jest.fn().mockReturnValue({ chat: jest.fn().mockReturnValue('model-handle') }),
}));

const generateObjectMock = generateObject as unknown as jest.Mock;

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
    generateObjectMock.mockResolvedValue({ object: { short_ids: ['106'] } });
    await expect(service.match(baseInput)).resolves.toEqual(['106']);
  });

  it('drops ids that are not in the open-job list', async () => {
    generateObjectMock.mockResolvedValue({ object: { short_ids: ['106', '999'] } });
    await expect(service.match(baseInput)).resolves.toEqual(['106']);
  });

  it('de-duplicates repeated ids', async () => {
    generateObjectMock.mockResolvedValue({ object: { short_ids: ['106', '106'] } });
    await expect(service.match(baseInput)).resolves.toEqual(['106']);
  });

  it('returns an empty array when the model declines to guess', async () => {
    generateObjectMock.mockResolvedValue({ object: { short_ids: [] } });
    await expect(service.match(baseInput)).resolves.toEqual([]);
  });

  it('returns an empty array instead of throwing when the call fails', async () => {
    generateObjectMock.mockRejectedValue(new Error('openrouter 503'));
    await expect(service.match(baseInput)).resolves.toEqual([]);
  });

  it('does not call the model when there are no open jobs', async () => {
    await expect(service.match({ ...baseInput, openJobs: [] })).resolves.toEqual([]);
    expect(generateObjectMock).not.toHaveBeenCalled();
  });
});
