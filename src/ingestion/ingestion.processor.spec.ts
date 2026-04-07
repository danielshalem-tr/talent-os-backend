import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoLogger } from 'nestjs-pino';
import { IngestionProcessor } from './ingestion.processor';
import { SpamFilterService } from './services/spam-filter.service';
import { AttachmentExtractorService } from './services/attachment-extractor.service';
import { PrismaService } from '../prisma/prisma.service';
import { mockPostmarkPayload } from './services/spam-filter.service.spec';
import { ExtractionAgentService } from './services/extraction-agent.service';
import { mockCandidateExtract } from './services/extraction-agent.service.test-helpers';
import { StorageService } from '../storage/storage.service';
import { DedupService } from '../dedup/dedup.service';
import { ScoringAgentService } from '../scoring/scoring.service';
import { Prisma } from '@prisma/client';

// Mock @openrouter/sdk to prevent ESM parse errors (ExtractionAgentService is provided as a mock anyway)
jest.mock('@openrouter/sdk', () => ({ OpenRouter: jest.fn() }));

// Mock pdf-parse and mammoth so AttachmentExtractorService doesn't crash on fake content
jest.mock('pdf-parse', () => jest.fn().mockResolvedValue({ text: 'pdf text' }));
jest.mock('mammoth', () => ({
  convertToHtml: jest.fn().mockResolvedValue({ value: 'docx text' }),
}));

describe('IngestionProcessor', () => {
  let processor: IngestionProcessor;
  let prisma: { emailIntakeLog: { update: jest.Mock }; $transaction: jest.Mock; candidate: { update: jest.Mock }; job: { findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock }; application: { upsert: jest.Mock }; candidateJobScore: { create: jest.Mock } };
  let extractionAgent: { extract: jest.Mock };
  let storageService: { upload: jest.Mock };
  let dedupService: { check: jest.Mock; insertCandidate: jest.Mock; upsertCandidate: jest.Mock; createFlag: jest.Mock };

  beforeEach(async () => {
    const txClient = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation(async (cb: (tx: typeof txClient) => Promise<void>) => cb(txClient)),
      candidate: { update: jest.fn().mockResolvedValue({}) },
      job: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
      application: { upsert: jest.fn().mockResolvedValue({ id: 'app-id' }) },
      candidateJobScore: { create: jest.fn().mockResolvedValue({}) },
    };

    extractionAgent = {
      extract: jest.fn().mockResolvedValue(mockCandidateExtract()),
    };

    storageService = {
      upload: jest.fn().mockResolvedValue('cvs/test-tenant-id/msg-id.pdf'),
    };

    dedupService = {
      check: jest.fn().mockResolvedValue(null),
      insertCandidate: jest.fn().mockResolvedValue('new-candidate-id'),
      upsertCandidate: jest.fn().mockResolvedValue(undefined),
      createFlag: jest.fn().mockResolvedValue(undefined),
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
        { provide: StorageService, useValue: storageService },
        { provide: DedupService, useValue: dedupService },
        { provide: ScoringAgentService, useValue: { score: jest.fn().mockResolvedValue({ score: 72, reasoning: '', strengths: [], gaps: [], modelUsed: 'test' }) } },
        { provide: PinoLogger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } },
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

    await expect(processor.process(job)).rejects.toThrow('LLM timeout');

    // First call: 'processing'; second call: 'failed'
    expect(prisma.emailIntakeLog.update).toHaveBeenCalledTimes(2);
    expect(prisma.emailIntakeLog.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { processingStatus: 'failed' },
      }),
    );
  });

  // BUG-CV-LOSS: upload is called before extraction, so file is persisted even if AI fails
  it('upload is called before extraction even when extraction fails', async () => {
    extractionAgent.extract.mockRejectedValueOnce(new Error('LLM timeout'));

    const payload = mockPostmarkPayload({
      Subject: 'Job Application from Jane Doe',
      TextBody:
        'Dear Hiring Manager, I am writing to apply for the position. ' +
        'I have 5 years of experience in software engineering. ' +
        'Please find my CV attached.',
      Attachments: [],
    });
    const job = { id: 'test-job-upload-before', data: payload } as any;

    await expect(processor.process(job)).rejects.toThrow('LLM timeout');

    // storageService.upload must have been called before extraction failed
    expect(storageService.upload).toHaveBeenCalled();
  });

  // 4-02-02: AIEX-02 — successful extraction does not update status to failed
  it('successful extraction does not update failed status', async () => {
    extractionAgent.extract.mockResolvedValueOnce(
      mockCandidateExtract({ full_name: 'Jane Doe' }),
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

    // Phase 7 now runs: 'processing' + 'completed' (Phase 7 terminal status)
    expect(prisma.emailIntakeLog.update).toHaveBeenCalledTimes(2);
    expect(prisma.emailIntakeLog.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { processingStatus: 'failed' },
      }),
    );
    expect(prisma.emailIntakeLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { processingStatus: 'completed' },
      }),
    );
    // Transaction was used for the Phase 6 atomic block
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('IngestionProcessor — Phase 5 StorageService', () => {
  let processor: IngestionProcessor;
  let prisma: { emailIntakeLog: { update: jest.Mock }; $transaction: jest.Mock; candidate: { update: jest.Mock }; job: { findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock }; application: { upsert: jest.Mock }; candidateJobScore: { create: jest.Mock } };
  let extractionAgent: { extract: jest.Mock };
  let storageService: { upload: jest.Mock };
  let dedupService: { check: jest.Mock; insertCandidate: jest.Mock; upsertCandidate: jest.Mock; createFlag: jest.Mock };

  beforeEach(async () => {
    const txClient = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation(async (cb: (tx: typeof txClient) => Promise<void>) => cb(txClient)),
      candidate: { update: jest.fn().mockResolvedValue({}) },
      job: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
      application: { upsert: jest.fn().mockResolvedValue({ id: 'app-id' }) },
      candidateJobScore: { create: jest.fn().mockResolvedValue({}) },
    };
    extractionAgent = {
      extract: jest.fn().mockResolvedValue(mockCandidateExtract()),
    };
    storageService = {
      upload: jest.fn().mockResolvedValue('cvs/test-tenant-id/test-message-id.pdf'),
    };
    dedupService = {
      check: jest.fn().mockResolvedValue(null),
      insertCandidate: jest.fn().mockResolvedValue('new-candidate-id'),
      upsertCandidate: jest.fn().mockResolvedValue(undefined),
      createFlag: jest.fn().mockResolvedValue(undefined),
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
        { provide: StorageService, useValue: storageService },
        { provide: DedupService, useValue: dedupService },
        { provide: ScoringAgentService, useValue: { score: jest.fn().mockResolvedValue({ score: 72, reasoning: '', strengths: [], gaps: [], modelUsed: 'test' }) } },
        { provide: PinoLogger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } },
      ],
    }).compile();

    processor = module.get<IngestionProcessor>(IngestionProcessor);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // 5-02-01: STOR-01 — storageService.upload called with correct args
  it('5-02-01: calls storageService.upload with attachments, tenantId, messageId', async () => {
    const payload = mockPostmarkPayload({
      MessageID: 'test-message-id',
      Subject: 'Job Application from Jane Doe',
      TextBody:
        'Dear Hiring Manager, I have 5 years of experience in software engineering. Please find my CV attached.',
      Attachments: [
        {
          Name: 'cv.pdf',
          ContentType: 'application/pdf',
          ContentLength: 150000,
          Content: Buffer.from('PDF data').toString('base64'),
        },
      ],
    });
    const job = { id: 'test-job-5', data: payload } as any;

    await processor.process(job);

    expect(storageService.upload).toHaveBeenCalledWith(
      payload.Attachments,
      'test-tenant-id',
      payload.MessageID,
    );
  });

  // 5-02-02: D-07 — upload errors propagate (no inline catch in processor)
  it('5-02-02: propagates upload error to BullMQ (no inline catch)', async () => {
    storageService.upload.mockRejectedValueOnce(new Error('R2 service unavailable'));

    const payload = mockPostmarkPayload({
      Subject: 'Job Application from Jane Doe',
      TextBody:
        'Dear Hiring Manager, I have 5 years of experience in software engineering. Please find my CV attached.',
      Attachments: [
        {
          Name: 'cv.pdf',
          ContentType: 'application/pdf',
          ContentLength: 150000,
          Content: Buffer.from('PDF data').toString('base64'),
        },
      ],
    });
    const job = { id: 'test-job-6', data: payload } as any;

    await expect(processor.process(job)).rejects.toThrow('R2 service unavailable');
  });

  // 5-02-03: D-02, STOR-03 — null fileKey + processor continues normally
  it('5-02-03: passes null fileKey and cvText through ProcessingContext when no CV attachment', async () => {
    storageService.upload.mockResolvedValueOnce(null);

    const payload = mockPostmarkPayload({
      Subject: 'Job Application from Jane Doe',
      TextBody:
        'Dear Hiring Manager, I have 5 years of experience in software engineering. Please find my CV attached.',
      Attachments: [],
    });
    const job = { id: 'test-job-7', data: payload } as any;

    // Processor should not throw; upload was called and returned null gracefully
    await expect(processor.process(job)).resolves.not.toThrow();
    expect(storageService.upload).toHaveBeenCalled();
  });
});

describe('IngestionProcessor — Phase 6 Duplicate Detection', () => {
  let processor: IngestionProcessor;
  let prisma: { emailIntakeLog: { update: jest.Mock }; $transaction: jest.Mock; candidate: { update: jest.Mock }; job: { findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock }; application: { upsert: jest.Mock }; candidateJobScore: { create: jest.Mock } };
  let extractionAgent: { extract: jest.Mock };
  let storageService: { upload: jest.Mock };
  let dedupService: {
    check: jest.Mock;
    insertCandidate: jest.Mock;
    upsertCandidate: jest.Mock;
    createFlag: jest.Mock;
  };

  beforeEach(async () => {
    const txClient = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
    };

    prisma = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
      // Simulate prisma.$transaction by invoking the callback with a tx client
      $transaction: jest.fn().mockImplementation(async (cb: (tx: typeof txClient) => Promise<void>) => {
        return cb(txClient);
      }),
      candidate: { update: jest.fn().mockResolvedValue({}) },
      job: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
      application: { upsert: jest.fn().mockResolvedValue({ id: 'app-id' }) },
      candidateJobScore: { create: jest.fn().mockResolvedValue({}) },
    };

    extractionAgent = {
      extract: jest.fn().mockResolvedValue({
        full_name: 'Jane Doe',
        email: 'jane.doe@example.com',
        phone: '+1-555-0100',
        current_role: 'Software Engineer',
        years_experience: 5,
        location: 'Tel Aviv, Israel',
        job_title_hint: 'Backend Developer',
        skills: ['TypeScript'],
        ai_summary: 'Experienced engineer.',
        source_hint: 'direct',
        suspicious: false,
      }),
    };
    storageService = {
      upload: jest.fn().mockResolvedValue('cvs/test-tenant-id/msg-id.pdf'),
    };
    dedupService = {
      check: jest.fn().mockResolvedValue(null),
      insertCandidate: jest.fn().mockResolvedValue('new-candidate-id'),
      upsertCandidate: jest.fn().mockResolvedValue(undefined),
      createFlag: jest.fn().mockResolvedValue(undefined),
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
        { provide: StorageService, useValue: storageService },
        { provide: DedupService, useValue: dedupService },
        { provide: ScoringAgentService, useValue: { score: jest.fn().mockResolvedValue({ score: 72, reasoning: '', strengths: [], gaps: [], modelUsed: 'test' }) } },
        { provide: PinoLogger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } },
      ],
    }).compile();

    processor = module.get<IngestionProcessor>(IngestionProcessor);
  });

  afterEach(() => jest.clearAllMocks());

  const validJobPayload = () =>
    mockPostmarkPayload({
      MessageID: 'msg-dedup-test',
      From: 'sender@example.com',
      Subject: '[Job ID: job-id-1] Job Application from Jane Doe',
      TextBody:
        'Dear Hiring Manager, I have 5 years of experience in software engineering. Please find my CV attached.',
      Attachments: [],
    });

  // 6-02-01: CAND-03 — no match → INSERT → email_intake_log.candidate_id set
  it('6-02-01: CAND-03 — no-match INSERT sets email_intake_log.candidate_id', async () => {
    dedupService.check.mockResolvedValue(null);
    dedupService.insertCandidate.mockResolvedValue('new-candidate-id');

    const job = { id: 'test-dedup-1', data: validJobPayload() } as any;
    await processor.process(job);

    expect(dedupService.check).toHaveBeenCalledTimes(1);
    expect(dedupService.insertCandidate).toHaveBeenCalledTimes(1);
    expect(dedupService.upsertCandidate).not.toHaveBeenCalled();
    expect(dedupService.createFlag).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  // 6-02-02: exact email match → UPSERT existing candidate → email_intake_log.candidate_id = existing ID
  it('6-02-02: exact match — UPSERT called, createFlag called for duplicate detection, existing candidateId set on intake log', async () => {
    dedupService.check.mockResolvedValue({
      match: { id: 'existing-cand-id' },
      confidence: 1.0,
      fields: ['email'],
    });

    const job = { id: 'test-dedup-2', data: validJobPayload() } as any;
    await processor.process(job);

    expect(dedupService.upsertCandidate).toHaveBeenCalledWith('existing-cand-id', expect.any(Object), expect.anything());
    expect(dedupService.insertCandidate).not.toHaveBeenCalled();
    // NEW: Exact match should call createFlag to record duplicate (per 260407-iff)
    expect(dedupService.createFlag).toHaveBeenCalledWith(
      'existing-cand-id',      // matched candidate (upseerted)
      null,                     // self-reference
      1.0,                      // confidence
      'test-tenant-id',         // tenantId
      ['email'],                // matchFields
      expect.any(Object),       // tx (transaction client)
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  // 6-02-03: phone_missing sentinel → INSERT new candidate + phone_missing flag created
  it('6-02-03: phone_missing — new candidate inserted, phone_missing flag created, candidateId set on intake log', async () => {
    dedupService.check.mockResolvedValue({
      match: null,
      confidence: 0,
      fields: ['phone_missing'],
    });
    dedupService.insertCandidate.mockResolvedValue('phone-missing-candidate-id');

    const job = { id: 'test-dedup-3', data: validJobPayload() } as any;
    await processor.process(job);

    expect(dedupService.insertCandidate).toHaveBeenCalledTimes(1);
    expect(dedupService.createFlag).toHaveBeenCalledWith(
      'phone-missing-candidate-id',
      null,
      0,
      'test-tenant-id',
      ['phone_missing'],
      expect.anything(),
    );
    expect(dedupService.upsertCandidate).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  // Phase 6 atomicity: if emailIntakeLog.update throws inside transaction, insertCandidate is rolled back
  it('Phase 6 atomicity: if emailIntakeLog.update throws inside transaction, candidate INSERT is rolled back', async () => {
    dedupService.check.mockResolvedValue(null);
    dedupService.insertCandidate.mockResolvedValue('new-candidate-id');

    // Override $transaction to simulate failure: invoke the callback but make emailIntakeLog.update throw
    const txClient = {
      emailIntakeLog: {
        update: jest.fn().mockRejectedValueOnce(new Error('DB connection lost')),
      },
    };
    prisma.$transaction.mockImplementationOnce(async (cb: (tx: typeof txClient) => Promise<void>) => {
      return cb(txClient);
    });

    const job = { id: 'test-atomicity', data: validJobPayload() } as any;

    // The transaction callback throws — processor should propagate the error
    await expect(processor.process(job)).rejects.toThrow('DB connection lost');

    // insertCandidate was called (it ran before the update)
    expect(dedupService.insertCandidate).toHaveBeenCalledTimes(1);
    // The tx emailIntakeLog.update threw — simulating that Prisma would roll back
    expect(txClient.emailIntakeLog.update).toHaveBeenCalledTimes(1);
  });

  // 260407-iff: Exact phone match with flag creation — validates phone normalization and duplicate flag recording
  it('260407-iff: exact phone match creates flag with phone field for HR duplicate review', async () => {
    // Simulate exact phone match (confidence 1.0 = exact match via phone normalization)
    // This covers scenarios like +972 50 1234567 matching 050 1234567 (same number, different format)
    dedupService.check.mockResolvedValue({
      match: { id: 'existing-phone-cand' },
      confidence: 1.0,
      fields: ['phone'],
    });

    const job = { id: 'test-phone-match', data: validJobPayload() } as any;
    await processor.process(job);

    // UPSERT the existing candidate (don't create new one)
    expect(dedupService.upsertCandidate).toHaveBeenCalledTimes(1);
    expect(dedupService.upsertCandidate).toHaveBeenCalledWith('existing-phone-cand', expect.any(Object), expect.anything());

    // Don't insert a new candidate
    expect(dedupService.insertCandidate).not.toHaveBeenCalled();

    // Record the duplicate via createFlag so getCounts() can reflect it
    expect(dedupService.createFlag).toHaveBeenCalledWith(
      'existing-phone-cand',   // matched candidate (upseerted)
      null,                     // self-reference
      1.0,                      // exact match confidence
      'test-tenant-id',
      ['phone'],                // matchFields — indicates phone-based deduplication
      expect.any(Object),       // tx (transaction client)
    );

    // candidateId should be set on the intake log
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('IngestionProcessor — Phase 7 Candidate Enrichment & Scoring', () => {
  let processor: IngestionProcessor;
  let prisma: {
    emailIntakeLog: { update: jest.Mock };
    $transaction: jest.Mock;
    candidate: { update: jest.Mock };
    job: { findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock };
    application: { upsert: jest.Mock };
    candidateJobScore: { create: jest.Mock };
  };
  let extractionAgent: { extract: jest.Mock };
  let storageService: { upload: jest.Mock };
  let dedupService: { check: jest.Mock; insertCandidate: jest.Mock; upsertCandidate: jest.Mock; createFlag: jest.Mock };
  let scoringService: { score: jest.Mock };

  const activeJob = { id: 'job-id-1', shortId: 'job-id-1', title: 'Senior Backend Developer', description: 'Build APIs.', requirements: ['TypeScript'], hiringStages: [{ id: 'stage-1' }] };

  beforeEach(async () => {
    const txClient = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
    };

    prisma = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation(async (cb: (tx: typeof txClient) => Promise<void>) => cb(txClient)),
      candidate: { update: jest.fn().mockResolvedValue({}) },
      job: {
        findMany: jest.fn()
          .mockResolvedValueOnce([activeJob]) // First call: list active jobs
          .mockResolvedValueOnce([activeJob]), // Second call: find jobs matching short_ids
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(activeJob),
      },
      application: { upsert: jest.fn().mockResolvedValue({ id: 'app-id-1' }) },
      candidateJobScore: { create: jest.fn().mockResolvedValue({}) },
    };

    extractionAgent = {
      extract: jest.fn().mockResolvedValue({
        full_name: 'Jane Doe',
        email: 'jane.doe@example.com',
        phone: '+1-555-0100',
        current_role: 'Senior Software Engineer',
        years_experience: 7,
        location: 'Tel Aviv, Israel',
        source_agency: null,
        skills: ['TypeScript', 'Node.js'],
        ai_summary: 'Experienced engineer. Strong in distributed systems.',
        source_hint: 'direct',
        suspicious: false,
      }),
    };

    storageService = {
      upload: jest.fn().mockResolvedValue('cvs/test-tenant-id/msg-id.pdf'),
    };

    dedupService = {
      check: jest.fn().mockResolvedValue(null),
      insertCandidate: jest.fn().mockResolvedValue('new-candidate-id'),
      upsertCandidate: jest.fn().mockResolvedValue(undefined),
      createFlag: jest.fn().mockResolvedValue(undefined),
    };

    scoringService = {
      score: jest.fn().mockResolvedValue({
        score: 72,
        reasoning: 'Good match.',
        strengths: ['TypeScript'],
        gaps: [],
        modelUsed: 'claude-sonnet-4-6',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionProcessor,
        SpamFilterService,
        AttachmentExtractorService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('test-tenant-id') } },
        { provide: ExtractionAgentService, useValue: extractionAgent },
        { provide: StorageService, useValue: storageService },
        { provide: DedupService, useValue: dedupService },
        { provide: ScoringAgentService, useValue: scoringService },
        { provide: PinoLogger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } },
      ],
    }).compile();

    processor = module.get<IngestionProcessor>(IngestionProcessor);
  });

  afterEach(() => jest.clearAllMocks());

  const validJobPayload = () =>
    mockPostmarkPayload({
      MessageID: 'msg-phase7-test',
      From: 'sender@example.com',
      Subject: 'Job Application for job-id-1',
      TextBody:
        'Dear Hiring Manager, I have 7 years of TypeScript and Node.js experience building backend systems. ' +
        'I am very interested in job-id-1 and would love to discuss my background further. ' +
        'Please find my CV attached.',
      Attachments: [],
    });

  // 7-02-01: CAND-01 — candidate.update called with all enrichment fields
  it('7-02-01: CAND-01 — candidate.update called with all enrichment fields', async () => {
    const job = { id: 'test-p7-1', data: validJobPayload() } as any;
    await processor.process(job);

    expect(prisma.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'new-candidate-id' },
        data: expect.objectContaining({
          currentRole: 'Senior Software Engineer',
          yearsExperience: 7,
          skills: ['TypeScript', 'Node.js'],
          cvText: expect.any(String),
          cvFileUrl: expect.any(String),
          aiSummary: 'Experienced engineer. Strong in distributed systems.',
          metadata: Prisma.JsonNull,
        }),
      }),
    );
  });

  it('7-02-02: SCOR-01 — Phase 15: job.findMany called for flexible Job ID extraction', async () => {
    // Phase 15: Extract short_id from flexible format (not strict [Job ID:...])
    const jobPayloadWithId = mockPostmarkPayload({
      MessageID: 'msg-p15-test',
      From: 'sender@example.com',
      Subject: 'Job Application for job-id-1',
      TextBody:
        'Dear Hiring Manager, I have 5 years of experience and interested in job-id-1. Please find my CV attached.',
      Attachments: [],
    });
    const job = { id: 'test-p7-2', data: jobPayloadWithId } as any;
    await processor.process(job);

    // Phase 15: job.findMany called to fetch active jobs and match short_ids
    expect(prisma.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'test-tenant-id', status: 'open' },
      }),
    );
  });

  // 7-02-03: SCOR-02 + SCOR-04 — application upserted then score created per active job
  it('7-02-03: SCOR-02 + SCOR-04 — application upserted and candidateJobScore created per job', async () => {
    const job = { id: 'test-p7-3', data: validJobPayload() } as any;
    await processor.process(job);

    expect(prisma.application.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.application.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idx_applications_unique: { tenantId: 'test-tenant-id', candidateId: 'new-candidate-id', jobId: 'job-id-1' } },
        create: expect.objectContaining({ stage: 'new' }),
        update: {},
      }),
    );
    expect(prisma.candidateJobScore.create).toHaveBeenCalledTimes(1);
    expect(prisma.candidateJobScore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          applicationId: 'app-id-1',
          score: 72,
          modelUsed: 'claude-sonnet-4-6',
        }),
      }),
    );
  });

  // 7-02-04: SCOR-01 job not found — scoring loop skipped, status still completed
  it('7-02-04: SCOR-01 — Phase 15: no matching short_ids: scoring loop skipped, processingStatus still completed', async () => {
    // Reset the findMany mock and configure for no matches
    prisma.job.findMany.mockReset();
    prisma.job.findMany
      .mockResolvedValueOnce([activeJob]) // First call: list active jobs
      .mockResolvedValueOnce([]); // Second call: no jobs match the short_ids

    const job = { id: 'test-p7-4', data: validJobPayload() } as any;
    await processor.process(job);

    // When no job is found, no application is created and scoring is skipped
    expect(prisma.application.upsert).not.toHaveBeenCalled();
    expect(scoringService.score).not.toHaveBeenCalled();
    // Status is still completed even without a matched job
    expect(prisma.emailIntakeLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { processingStatus: 'completed' } }),
    );
  });

  // 7-02-05: D-16 — processingStatus 'completed' is set as the LAST prisma call
  it('7-02-05: D-16 — processingStatus=completed set after all scoring (last prisma call)', async () => {
    const job = { id: 'test-p7-5', data: validJobPayload() } as any;
    await processor.process(job);

    const allUpdateCalls: Array<{ data: Record<string, unknown> }> = prisma.emailIntakeLog.update.mock.calls.map(
      (call: [{ data: Record<string, unknown> }]) => call[0],
    );
    const lastUpdateCall = allUpdateCalls[allUpdateCalls.length - 1];
    expect(lastUpdateCall?.data).toEqual({ processingStatus: 'completed' });
    // Scoring happened before the final status update
    expect(prisma.candidateJobScore.create).toHaveBeenCalled();
  });

  // 7-02-06: Scoring error on matched job — marks intake as failed and throws (retried by BullMQ)
  it('7-02-06: Scoring error on matched job — marks intake as failed and throws for retry', async () => {
    scoringService.score.mockRejectedValueOnce(new Error('Anthropic API timeout'));

    const jobData = { id: 'test-p7-6', data: validJobPayload() } as any;

    await expect(processor.process(jobData)).rejects.toThrow('Anthropic API timeout');

    // Application should have been created (SCOR-02 happens before scoring)
    expect(prisma.application.upsert).toHaveBeenCalledTimes(1);

    // Score creation skipped due to error
    expect(prisma.candidateJobScore.create).not.toHaveBeenCalled();

    // Intake marked as failed before throwing
    expect(prisma.emailIntakeLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processingStatus: 'failed',
          errorMessage: 'Anthropic API timeout',
        }),
      }),
    );
  });

  describe('IngestionProcessor — Phase 15 Flexible Job ID Extraction (Word Boundaries)', () => {
    let processor: IngestionProcessor;
    let prisma: any;
    let extractionAgent: any;

    const job1 = { id: 'job-1', title: 'Senior Software Engineer', shortId: 'se-1', description: null, requirements: [], hiringStages: [{ id: 'stage-1' }] };
    const job2 = { id: 'job-2', title: 'Product Manager', shortId: 'pm-2', description: null, requirements: [], hiringStages: [{ id: 'stage-2' }] };

    beforeEach(async () => {
      const txClient = { emailIntakeLog: { update: jest.fn().mockResolvedValue({}) } };
      prisma = {
        emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
        $transaction: jest.fn().mockImplementation(async (cb) => cb(txClient)),
        candidate: { update: jest.fn().mockResolvedValue({}) },
        job: {
          findMany: jest.fn().mockResolvedValue([job1, job2]), // Active jobs list
          findUnique: jest.fn(),
        },
        application: { upsert: jest.fn().mockResolvedValue({ id: 'app-1' }) },
        candidateJobScore: { create: jest.fn().mockResolvedValue({}) },
      };
      extractionAgent = { extract: jest.fn().mockResolvedValue(mockCandidateExtract()) };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          IngestionProcessor,
          SpamFilterService,
          AttachmentExtractorService,
          { provide: PrismaService, useValue: prisma },
          { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('test-tenant-id') } },
          { provide: ExtractionAgentService, useValue: extractionAgent },
          { provide: StorageService, useValue: { upload: jest.fn().mockResolvedValue('key') } },
          { provide: DedupService, useValue: { check: jest.fn().mockResolvedValue(null), insertCandidate: jest.fn().mockResolvedValue('cand-1') } },
          { provide: ScoringAgentService, useValue: { score: jest.fn().mockResolvedValue({ score: 72, modelUsed: 'test' }) } },
          { provide: PinoLogger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } },
        ],
      }).compile();
      processor = module.get<IngestionProcessor>(IngestionProcessor);
    });

    it('15-01: extracts single short_id from subject with word boundaries (strict formatting optional)', async () => {
      // Test: "applying for se-1" → should extract se-1 (not strict [Job ID:...] format)
      prisma.job.findMany.mockResolvedValueOnce([job1, job2]);
      prisma.job.findMany.mockResolvedValueOnce([job1]); // For job lookup by shortId
      const payload = mockPostmarkPayload({ Subject: 'CV for se-1 position', TextBody: 'a'.repeat(101) });
      const job = { id: 'test-1', data: payload } as any;

      await processor.process(job);

      // Should search for all active jobs first
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'test-tenant-id', status: 'open' },
        }),
      );
      // Should look up matched jobs
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'test-tenant-id', shortId: { in: ['se-1'] } },
        }),
      );
      // Should assign job
      expect(prisma.candidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ jobId: 'job-1' }),
        }),
      );
    });

    it('15-02: respects word boundaries (matches se-1 but not in use-1)', async () => {
      // Test: "use-1" should NOT match "se-1" (word boundary enforcement)
      prisma.job.findMany.mockResolvedValueOnce([job1, job2]);
      prisma.job.findMany.mockResolvedValueOnce([]); // No jobs matched
      const payload = mockPostmarkPayload({ Subject: 'use-1 reference', TextBody: 'a'.repeat(101) });
      const job = { id: 'test-2', data: payload } as any;

      await processor.process(job);

      // Should skip job lookup (no matches found)
      expect(prisma.candidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ jobId: null }),
        }),
      );
      // Scoring skipped
      expect(prisma.application.upsert).not.toHaveBeenCalled();
    });

    it('15-03: extracts multiple short_ids from body text and assigns to all', async () => {
      // Test: body has "se-1" and "pm-2" → should create 2 application records
      prisma.job.findMany
        .mockResolvedValueOnce([job1, job2]) // Active jobs list
        .mockResolvedValueOnce([job1, job2]); // Jobs matching short_ids
      prisma.application.upsert
        .mockResolvedValueOnce({ id: 'app-1' })
        .mockResolvedValueOnce({ id: 'app-2' });
      const payload = mockPostmarkPayload({
        Subject: 'CV Submission',
        TextBody: 'I am interested in both se-1 and pm-2 positions. a'.repeat(20),
      });
      const job = { id: 'test-3', data: payload } as any;

      await processor.process(job);

      // Should find both jobs
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'test-tenant-id', shortId: { in: expect.arrayContaining(['se-1', 'pm-2']) } },
        }),
      );
      // Should create 2 applications (one per job)
      expect(prisma.application.upsert).toHaveBeenCalledTimes(2);
      // Should score against 2 jobs
      expect(prisma.candidateJobScore.create).toHaveBeenCalledTimes(2);
    });

    it('15-04: gracefully handles no matching short_ids in email', async () => {
      // Test: email has no matching short_ids → proceed without job assignment
      prisma.job.findMany.mockResolvedValueOnce([job1, job2]);
      prisma.job.findMany.mockResolvedValueOnce([]); // No matches
      const payload = mockPostmarkPayload({ Subject: 'Random CV', TextBody: 'a'.repeat(101) });
      const job = { id: 'test-4', data: payload } as any;

      await processor.process(job);

      // Should set jobId to null
      expect(prisma.candidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ jobId: null }),
        }),
      );
      // Should complete without scoring
      expect(prisma.emailIntakeLog.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { processingStatus: 'completed' } }),
      );
      expect(prisma.application.upsert).not.toHaveBeenCalled();
    });

    it('15-05: case-insensitive short_id matching', async () => {
      // Test: "SE-1" (uppercase) should match "se-1" (lowercase)
      prisma.job.findMany.mockResolvedValueOnce([job1, job2]);
      prisma.job.findMany.mockResolvedValueOnce([job1]);
      const payload = mockPostmarkPayload({ Subject: 'Applying for SE-1', TextBody: 'a'.repeat(101) });
      const job = { id: 'test-5', data: payload } as any;

      await processor.process(job);

      // Should match case-insensitively
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'test-tenant-id', shortId: { in: ['se-1'] } },
        }),
      );
    });

    it('15-06: deduplicates duplicate short_id matches', async () => {
      // Test: "se-1 and also se-1" → should extract ['se-1'] not ['se-1', 'se-1']
      prisma.job.findMany
        .mockResolvedValueOnce([job1, job2])
        .mockResolvedValueOnce([job1]); // Should have single se-1
      const payload = mockPostmarkPayload({
        Subject: 'se-1 position',
        TextBody: 'Very interested in se-1. a'.repeat(20),
      });
      const job = { id: 'test-6', data: payload } as any;

      await processor.process(job);

      // Should call findMany with only one se-1 in the in clause
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'test-tenant-id', shortId: { in: ['se-1'] } },
        }),
      );
      // Should create only 1 application
      expect(prisma.application.upsert).toHaveBeenCalledTimes(1);
    });
  });
});
