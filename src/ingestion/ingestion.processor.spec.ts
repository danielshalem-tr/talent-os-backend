import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IngestionProcessor } from './ingestion.processor';
import { SpamFilterService } from './services/spam-filter.service';
import { AttachmentExtractorService } from './services/attachment-extractor.service';
import { PrismaService } from '../prisma/prisma.service';
import { mockPostmarkPayload } from './services/spam-filter.service.spec';
import { ExtractionAgentService } from './services/extraction-agent.service';
import { mockCandidateExtract } from './services/extraction-agent.service.spec';

// Mock pdf-parse and mammoth so AttachmentExtractorService doesn't crash on fake content
jest.mock('pdf-parse', () => jest.fn().mockResolvedValue({ text: 'pdf text' }));
jest.mock('mammoth', () => ({
  convertToHtml: jest.fn().mockResolvedValue({ value: 'docx text' }),
}));

describe('IngestionProcessor', () => {
  let processor: IngestionProcessor;
  let prisma: { emailIntakeLog: { update: jest.Mock } };
  let extractionAgent: { extract: jest.Mock };

  beforeEach(async () => {
    prisma = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
    };

    extractionAgent = {
      extract: jest.fn().mockResolvedValue(mockCandidateExtract()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionProcessor,
        SpamFilterService,
        AttachmentExtractorService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-tenant-id') },
        },
        { provide: ExtractionAgentService, useValue: extractionAgent },
      ],
    }).compile();

    processor = module.get<IngestionProcessor>(IngestionProcessor);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // 3-03-01: PROC-06 — spam rejection updates status to 'spam'
  it('hard reject updates status', async () => {
    // Payload with no attachment and short body → spamFilter returns { isSpam: true }
    const payload = mockPostmarkPayload({
      TextBody: 'hi',
      Attachments: [],
    });
    const job = { id: 'test-job-1', data: payload } as any;

    await processor.process(job);

    expect(prisma.emailIntakeLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { processingStatus: 'spam' },
      }),
    );
    // Processor returned after spam — update called only once (not 'processing')
    expect(prisma.emailIntakeLog.update).toHaveBeenCalledTimes(1);
  });

  // 3-03-02: PROC-06 — passing email updates status to 'processing'
  it('pass filter updates status', async () => {
    // Clean email with long body — no spam keywords, no short body
    const payload = mockPostmarkPayload({
      Subject: 'Job Application from Jane Doe',
      TextBody: 'Dear Hiring Manager, I am writing to apply for the position. ' +
                'I have 5 years of experience in software engineering. ' +
                'Please find my CV attached.',
      Attachments: [],
    });
    const job = { id: 'test-job-2', data: payload } as any;

    await processor.process(job);

    expect(prisma.emailIntakeLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { processingStatus: 'processing' },
      }),
    );
  });

  // 4-02-01: AIEX-01 — extraction failure marks log as 'failed' and returns
  it('extraction failure marks status failed', async () => {
    extractionAgent.extract.mockRejectedValueOnce(new Error('LLM timeout'));

    const payload = mockPostmarkPayload({
      Subject: 'Job Application from Jane Doe',
      TextBody:
        'Dear Hiring Manager, I am writing to apply for the position. ' +
        'I have 5 years of experience in software engineering. ' +
        'Please find my CV attached.',
      Attachments: [],
    });
    const job = { id: 'test-job-3', data: payload } as any;

    await processor.process(job);

    // First call: 'processing'; second call: 'failed'
    expect(prisma.emailIntakeLog.update).toHaveBeenCalledTimes(2);
    expect(prisma.emailIntakeLog.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { processingStatus: 'failed' },
      }),
    );
  });

  // 4-02-02: AIEX-02 — successful extraction does not update status to failed
  it('successful extraction does not update failed status', async () => {
    extractionAgent.extract.mockResolvedValueOnce(
      mockCandidateExtract({ fullName: 'Jane Doe' }),
    );

    const payload = mockPostmarkPayload({
      Subject: 'Job Application from Jane Doe',
      TextBody:
        'Dear Hiring Manager, I am writing to apply for the position. ' +
        'I have 5 years of experience in software engineering. ' +
        'Please find my CV attached.',
      Attachments: [],
    });
    const job = { id: 'test-job-4', data: payload } as any;

    await processor.process(job);

    // Only one prisma.update call ('processing') — no 'failed' call
    expect(prisma.emailIntakeLog.update).toHaveBeenCalledTimes(1);
    expect(prisma.emailIntakeLog.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { processingStatus: 'failed' },
      }),
    );
  });
});
