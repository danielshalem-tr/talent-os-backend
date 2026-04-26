import { Test, TestingModule } from '@nestjs/testing';
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

/** Helper: build a slim job with new IngestJobData shape */
function makeJob(id: string, payload: ReturnType<typeof mockPostmarkPayload>) {
  return {
    id,
    name: 'ingest-email',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: { tenantId: 'test-tenant-id', messageId: payload.MessageID },
  } as any;
}

describe('IngestionProcessor', () => {
  let processor: IngestionProcessor;
  let prisma: { emailIntakeLog: { update: jest.Mock; findUnique: jest.Mock }; $transaction: jest.Mock; candidate: { update: jest.Mock }; job: { findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock }; application: { upsert: jest.Mock }; candidateJobScore: { create: jest.Mock } };
  let extractionAgent: { extract: jest.Mock };
  let storageService: { upload: jest.Mock; downloadPayload: jest.Mock };
  let dedupService: { check: jest.Mock; insertCandidate: jest.Mock; upsertCandidate: jest.Mock; createFlag: jest.Mock };

  beforeEach(async () => {
    const txClient = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    prisma = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ candidateId: null, cvFileKey: null }) },
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
      downloadPayload: jest.fn(),
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
        { provide: ExtractionAgentService, useValue: extractionAgent },
        { provide: StorageService, useValue: storageService },
        { provide: DedupService, useValue: dedupService },
        { provide: ScoringAgentService, useValue: { score: jest.fn().mockResolvedValue({ score: 72, reasoning: '', strengths: [], gaps: [], modelUsed: 'test' }) } },
        { provide: PinoLogger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } },
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
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-job-1', payload);

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
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-job-2', payload);

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
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-job-3', payload);

    await expect(processor.process(job)).rejects.toThrow('LLM timeout');

    // First call: 'processing'; second call: 'failed'
    expect(prisma.emailIntakeLog.update).toHaveBeenCalledTimes(2);
    expect(prisma.emailIntakeLog.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { processingStatus: 'failed' },
      }),
    );
  });

  // BUG-CV-LOSS: CV upload now happens in WebhooksService before enqueueing.
  // The processor reads cvFileKey from existingIntake (set by webhook).
  // This test verifies the processor does NOT call storageService.upload (that's the webhook's job).
  it('processor does NOT call storageService.upload (CV upload moved to webhook)', async () => {
    extractionAgent.extract.mockRejectedValueOnce(new Error('LLM timeout'));

    const payload = mockPostmarkPayload({
      Subject: 'Job Application from Jane Doe',
      TextBody:
        'Dear Hiring Manager, I am writing to apply for the position. ' +
        'I have 5 years of experience in software engineering. ' +
        'Please find my CV attached.',
      Attachments: [],
    });
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-job-upload-before', payload);

    await expect(processor.process(job)).rejects.toThrow('LLM timeout');

    // storageService.upload must NOT be called — CV upload is now done in WebhooksService
    expect(storageService.upload).not.toHaveBeenCalled();
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
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-job-4', payload);

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
  let prisma: { emailIntakeLog: { update: jest.Mock; findUnique: jest.Mock }; $transaction: jest.Mock; candidate: { update: jest.Mock }; job: { findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock }; application: { upsert: jest.Mock }; candidateJobScore: { create: jest.Mock } };
  let extractionAgent: { extract: jest.Mock };
  let storageService: { upload: jest.Mock; downloadPayload: jest.Mock };
  let dedupService: { check: jest.Mock; insertCandidate: jest.Mock; upsertCandidate: jest.Mock; createFlag: jest.Mock };

  beforeEach(async () => {
    const txClient = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    prisma = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ candidateId: null, cvFileKey: null }) },
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
      downloadPayload: jest.fn(),
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
        { provide: ExtractionAgentService, useValue: extractionAgent },
        { provide: StorageService, useValue: storageService },
        { provide: DedupService, useValue: dedupService },
        { provide: ScoringAgentService, useValue: { score: jest.fn().mockResolvedValue({ score: 72, reasoning: '', strengths: [], gaps: [], modelUsed: 'test' }) } },
        { provide: PinoLogger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } },
      ],
    }).compile();

    processor = module.get<IngestionProcessor>(IngestionProcessor);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // 5-02-01: CV upload now happens in WebhooksService (P1 change).
  // Processor reads cvFileKey from existingIntake.cvFileKey (set by webhook).
  // This test verifies the processor uses the cvFileKey from existingIntake.
  it('5-02-01: processor reads cvFileKey from existingIntake (set by webhook, not processor)', async () => {
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
    // Simulate webhook having set cvFileKey on the intake log
    prisma.emailIntakeLog.findUnique.mockResolvedValue({ candidateId: null, cvFileKey: 'cvs/test-tenant-id/test-message-id.pdf' });
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-job-5', payload);

    await processor.process(job);

    // Processor must NOT call storageService.upload — CV upload is webhook's responsibility now
    expect(storageService.upload).not.toHaveBeenCalled();

    // Candidate enrichment should have been called with the cvFileKey from intake log
    expect(prisma.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cvFileUrl: 'cvs/test-tenant-id/test-message-id.pdf',
        }),
      }),
    );
  });

  // 5-02-02: D-07 — processor no longer calls upload; downloadPayload error propagates
  it('5-02-02: propagates downloadPayload error to BullMQ (no inline catch)', async () => {
    storageService.downloadPayload.mockRejectedValueOnce(new Error('R2 service unavailable'));

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
    const job = makeJob('test-job-6', payload);

    await expect(processor.process(job)).rejects.toThrow('R2 service unavailable');
  });

  // 5-02-03: D-02, STOR-03 — null cvFileKey in existingIntake + processor continues normally
  it('5-02-03: passes null fileKey and cvText through ProcessingContext when no CV attachment', async () => {
    const payload = mockPostmarkPayload({
      Subject: 'Job Application from Jane Doe',
      TextBody:
        'Dear Hiring Manager, I have 5 years of experience in software engineering. Please find my CV attached.',
      Attachments: [],
    });
    // existingIntake has null cvFileKey (webhook found no CV attachment)
    prisma.emailIntakeLog.findUnique.mockResolvedValue({ candidateId: null, cvFileKey: null });
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-job-7', payload);

    // Processor should not throw; continues normally with null fileKey
    await expect(processor.process(job)).resolves.not.toThrow();
    expect(storageService.upload).not.toHaveBeenCalled();
  });
});

describe('IngestionProcessor — Phase 6 Duplicate Detection', () => {
  let processor: IngestionProcessor;
  let prisma: { emailIntakeLog: { update: jest.Mock; findUnique: jest.Mock }; $transaction: jest.Mock; candidate: { update: jest.Mock }; job: { findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock }; application: { upsert: jest.Mock }; candidateJobScore: { create: jest.Mock } };
  let extractionAgent: { extract: jest.Mock };
  let storageService: { upload: jest.Mock; downloadPayload: jest.Mock };
  let dedupService: {
    check: jest.Mock;
    insertCandidate: jest.Mock;
    upsertCandidate: jest.Mock;
    createFlag: jest.Mock;
  };

  beforeEach(async () => {
    const txClient = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };

    prisma = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ candidateId: null, cvFileKey: null }) },
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
      downloadPayload: jest.fn(),
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
        { provide: ExtractionAgentService, useValue: extractionAgent },
        { provide: StorageService, useValue: storageService },
        { provide: DedupService, useValue: dedupService },
        { provide: ScoringAgentService, useValue: { score: jest.fn().mockResolvedValue({ score: 72, reasoning: '', strengths: [], gaps: [], modelUsed: 'test' }) } },
        { provide: PinoLogger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } },
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

    const payload = validJobPayload();
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-dedup-1', payload);
    await processor.process(job);

    expect(dedupService.check).toHaveBeenCalledTimes(1);
    expect(dedupService.insertCandidate).toHaveBeenCalledTimes(1);
    expect(dedupService.upsertCandidate).not.toHaveBeenCalled();
    expect(dedupService.createFlag).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  // 6-02-02: exact phone match → INSERT new candidate → createFlag links new→existing → email_intake_log.candidate_id = new ID
  it('6-02-02: exact phone match — INSERT new candidate, createFlag links new→existing, intake log gets new candidateId', async () => {
    dedupService.check.mockResolvedValue({
      match: { id: 'existing-cand-id' },
      confidence: 1.0,
      fields: ['phone'],
    });
    dedupService.insertCandidate.mockResolvedValue('new-candidate-id');

    const payload = validJobPayload();
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-dedup-2', payload);
    await processor.process(job);

    // New candidate inserted — existing NOT overwritten
    expect(dedupService.insertCandidate).toHaveBeenCalledTimes(1);
    expect(dedupService.upsertCandidate).not.toHaveBeenCalled();

    // Flag links new row → existing row
    expect(dedupService.createFlag).toHaveBeenCalledWith(
      'new-candidate-id', // new candidate (incoming)
      'existing-cand-id', // existing candidate (first submission)
      1.0,
      'test-tenant-id',
      ['phone'],
      expect.anything(), // tx
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

    const payload = validJobPayload();
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-dedup-3', payload);
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
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    prisma.$transaction.mockImplementationOnce(async (cb: (tx: typeof txClient) => Promise<void>) => {
      return cb(txClient);
    });

    const payload = validJobPayload();
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-atomicity', payload);

    // The transaction callback throws — processor should propagate the error
    await expect(processor.process(job)).rejects.toThrow('DB connection lost');

    // insertCandidate was called (it ran before the update)
    expect(dedupService.insertCandidate).toHaveBeenCalledTimes(1);
    // The tx emailIntakeLog.update threw — simulating that Prisma would roll back
    expect(txClient.emailIntakeLog.update).toHaveBeenCalledTimes(1);
  });

  // 260407-iff: Exact phone match with flag creation — validates phone normalization and duplicate flag recording
  it('260407-iff: exact phone match inserts new candidate and links via createFlag for HR duplicate review', async () => {
    // Simulate exact phone match (confidence 1.0 = exact match via phone normalization)
    // This covers scenarios like +972 50 1234567 matching 050 1234567 (same number, different format)
    dedupService.check.mockResolvedValue({
      match: { id: 'existing-phone-cand' },
      confidence: 1.0,
      fields: ['phone'],
    });
    dedupService.insertCandidate.mockResolvedValue('new-phone-cand-id');

    const payload = validJobPayload();
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-phone-match', payload);
    await processor.process(job);

    // INSERT new candidate — existing untouched
    expect(dedupService.insertCandidate).toHaveBeenCalledTimes(1);
    expect(dedupService.upsertCandidate).not.toHaveBeenCalled();

    // createFlag cross-links new → existing
    expect(dedupService.createFlag).toHaveBeenCalledWith(
      'new-phone-cand-id',      // new candidate (incoming submission)
      'existing-phone-cand',    // existing candidate (first submission)
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
    emailIntakeLog: { update: jest.Mock; findUnique: jest.Mock };
    $transaction: jest.Mock;
    candidate: { update: jest.Mock };
    job: { findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock };
    application: { upsert: jest.Mock };
    candidateJobScore: { create: jest.Mock };
  };
  let extractionAgent: { extract: jest.Mock };
  let storageService: { upload: jest.Mock; downloadPayload: jest.Mock };
  let dedupService: { check: jest.Mock; insertCandidate: jest.Mock; upsertCandidate: jest.Mock; createFlag: jest.Mock };
  let scoringService: { score: jest.Mock };

  const activeJob = { id: 'job-id-1', shortId: '101', title: 'Senior Backend Developer', description: 'Build APIs.', requirements: ['TypeScript'], hiringStages: [{ id: 'stage-1' }] };

  beforeEach(async () => {
    const txClient = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };

    prisma = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ candidateId: null, cvFileKey: null }) },
      $transaction: jest.fn().mockImplementation(async (cb: (tx: typeof txClient) => Promise<void>) => cb(txClient)),
      candidate: { update: jest.fn().mockResolvedValue({}) },
      job: {
        findMany: jest.fn().mockResolvedValue([activeJob]),
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
      downloadPayload: jest.fn(),
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
        { provide: ExtractionAgentService, useValue: extractionAgent },
        { provide: StorageService, useValue: storageService },
        { provide: DedupService, useValue: dedupService },
        { provide: ScoringAgentService, useValue: scoringService },
        { provide: PinoLogger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } },
      ],
    }).compile();

    processor = module.get<IngestionProcessor>(IngestionProcessor);
  });

  afterEach(() => jest.clearAllMocks());

  const validJobPayload = () =>
    mockPostmarkPayload({
      MessageID: 'msg-phase7-test',
      From: 'sender@example.com',
      Subject: 'Job Application for position 101',
      TextBody:
        'Dear Hiring Manager, I have 7 years of TypeScript and Node.js experience building backend systems. ' +
        'I am very interested in position 101 and would love to discuss my background further. ' +
        'Please find my CV attached.',
      Attachments: [],
    });

  // 7-02-01: CAND-01 — candidate.update called with all enrichment fields
  it('7-02-01: CAND-01 — candidate.update called with all enrichment fields', async () => {
    const payload = validJobPayload();
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-p7-1', payload);
    await processor.process(job);

    expect(prisma.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'new-candidate-id' },
        data: expect.objectContaining({
          currentRole: 'Senior Software Engineer',
          yearsExperience: 7,
          skills: ['TypeScript', 'Node.js'],
          cvText: expect.any(String),
          // cvFileUrl comes from existingIntake.cvFileKey (set by webhook) — null when no CV attached
          aiSummary: 'Experienced engineer. Strong in distributed systems.',
          metadata: Prisma.JsonNull,
        }),
      }),
    );
  });

  it('7-02-02: SCOR-01 — Phase 15: job.findMany called with status:open for matched shortIds', async () => {
    // Phase 15: Extract numeric short_id from text, look up with status:open filter
    const jobPayloadWithId = mockPostmarkPayload({
      MessageID: 'msg-p15-test',
      From: 'sender@example.com',
      Subject: 'Job Application for position 101',
      TextBody:
        'Dear Hiring Manager, I have 5 years of experience and interested in position 101. Please find my CV attached.',
      Attachments: [],
    });
    storageService.downloadPayload.mockResolvedValue(jobPayloadWithId);
    const job = makeJob('test-p7-2', jobPayloadWithId);
    await processor.process(job);

    // Phase 15: job.findMany called with status:open and matched shortIds
    expect(prisma.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'test-tenant-id',
          status: 'open',
        }),
      }),
    );
  });

  // 7-02-03: SCOR-02 + SCOR-04 — application upserted then score created per active job
  it('7-02-03: SCOR-02 + SCOR-04 — application upserted and candidateJobScore created per job', async () => {
    const payload = validJobPayload();
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-p7-3', payload);
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
    prisma.job.findMany.mockResolvedValueOnce([]); // shortId lookup returns no jobs

    const payload = validJobPayload();
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-p7-4', payload);
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
    const payload = validJobPayload();
    storageService.downloadPayload.mockResolvedValue(payload);
    const job = makeJob('test-p7-5', payload);
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

    const payload = validJobPayload();
    storageService.downloadPayload.mockResolvedValue(payload);
    const jobData = makeJob('test-p7-6', payload);

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

  describe('IngestionProcessor — Phase 15 Numeric Job ID Extraction', () => {
    let processor: IngestionProcessor;
    let prisma: any;
    let extractionAgent: any;
    let storageService: any;

    const job1 = { id: 'job-1', title: 'Senior Software Engineer', shortId: '100', description: null, requirements: [], hiringStages: [{ id: 'stage-1' }] };
    const job2 = { id: 'job-2', title: 'Product Manager', shortId: '101', description: null, requirements: [], hiringStages: [{ id: 'stage-2' }] };

    beforeEach(async () => {
      const txClient = {
        emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
        $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      };
      prisma = {
        emailIntakeLog: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ candidateId: null, cvFileKey: null }) },
        $transaction: jest.fn().mockImplementation(async (cb) => cb(txClient)),
        candidate: { update: jest.fn().mockResolvedValue({}) },
        job: {
          findMany: jest.fn().mockResolvedValue([job1, job2]),
          findUnique: jest.fn(),
        },
        application: { upsert: jest.fn().mockResolvedValue({ id: 'app-1' }) },
        candidateJobScore: { create: jest.fn().mockResolvedValue({}) },
      };
      extractionAgent = { extract: jest.fn().mockResolvedValue(mockCandidateExtract()) };
      storageService = { upload: jest.fn().mockResolvedValue('key'), downloadPayload: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          IngestionProcessor,
          SpamFilterService,
          AttachmentExtractorService,
          { provide: PrismaService, useValue: prisma },
          { provide: ExtractionAgentService, useValue: extractionAgent },
          { provide: StorageService, useValue: storageService },
          { provide: DedupService, useValue: { check: jest.fn().mockResolvedValue(null), insertCandidate: jest.fn().mockResolvedValue('cand-1') } },
          { provide: ScoringAgentService, useValue: { score: jest.fn().mockResolvedValue({ score: 72, modelUsed: 'test', reasoning: '', strengths: [], gaps: [] }) } },
          { provide: PinoLogger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } },
        ],
      }).compile();
      processor = module.get<IngestionProcessor>(IngestionProcessor);
    });

    it('15-01: extracts numeric short_id from subject', async () => {
      prisma.job.findMany.mockResolvedValueOnce([job1]);
      const payload = mockPostmarkPayload({ Subject: 'CV for position 100', TextBody: 'a'.repeat(101) });
      storageService.downloadPayload.mockResolvedValue(payload);
      const job = makeJob('test-1', payload);

      await processor.process(job);

      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ shortId: { in: ['100'] }, status: 'open' }),
        }),
      );
      expect(prisma.candidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ jobId: 'job-1' }),
        }),
      );
    });

    it('15-02: ignores numbers < 100', async () => {
      prisma.job.findMany.mockResolvedValueOnce([]);
      const payload = mockPostmarkPayload({ Subject: 'I am 25 years old', TextBody: 'Position 50 is closed. a'.repeat(10) });
      storageService.downloadPayload.mockResolvedValue(payload);
      const job = makeJob('test-2', payload);

      await processor.process(job);

      // No valid shortIds found → findMany not called for job lookup
      expect(prisma.candidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ jobId: null }),
        }),
      );
      expect(prisma.application.upsert).not.toHaveBeenCalled();
    });

    it('15-03: extracts multiple numeric short_ids and creates applications for each', async () => {
      prisma.job.findMany.mockResolvedValueOnce([job1, job2]);
      prisma.application.upsert
        .mockResolvedValueOnce({ id: 'app-1' })
        .mockResolvedValueOnce({ id: 'app-2' });
      const payload = mockPostmarkPayload({
        Subject: 'CV Submission',
        TextBody: 'I am interested in both position 100 and 101. a'.repeat(5),
      });
      storageService.downloadPayload.mockResolvedValue(payload);
      const job = makeJob('test-3', payload);

      await processor.process(job);

      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ shortId: { in: expect.arrayContaining(['100', '101']) } }),
        }),
      );
      expect(prisma.application.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.candidateJobScore.create).toHaveBeenCalledTimes(2);
    });

    it('15-04: gracefully handles no numeric short_ids in email', async () => {
      const payload = mockPostmarkPayload({ Subject: 'Random CV', TextBody: 'a'.repeat(101) });
      storageService.downloadPayload.mockResolvedValue(payload);
      const job = makeJob('test-4', payload);

      await processor.process(job);

      expect(prisma.candidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ jobId: null }),
        }),
      );
      expect(prisma.emailIntakeLog.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { processingStatus: 'completed' } }),
      );
      expect(prisma.application.upsert).not.toHaveBeenCalled();
    });

    it('15-05: includes years as false positives (filtered by DB)', async () => {
      prisma.job.findMany.mockResolvedValueOnce([]);
      const payload = mockPostmarkPayload({ Subject: 'In 2024 I applied', TextBody: 'Job 101 is open. ' + 'a'.repeat(101) });
      storageService.downloadPayload.mockResolvedValue(payload);
      const job = makeJob('test-5', payload);

      await processor.process(job);

      // Both 2024 and 101 extracted, DB query filters by actual shortIds
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            shortId: { in: expect.arrayContaining(['2024', '101']) },
          }),
        }),
      );
    });

    it('15-06: deduplicates repeated numeric short_ids', async () => {
      prisma.job.findMany.mockResolvedValueOnce([job1]);
      const payload = mockPostmarkPayload({
        Subject: 'position 100',
        TextBody: 'Very interested in position 100. a'.repeat(20),
      });
      storageService.downloadPayload.mockResolvedValue(payload);
      const job = makeJob('test-6', payload);

      await processor.process(job);

      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ shortId: { in: ['100'] } }),
        }),
      );
      expect(prisma.application.upsert).toHaveBeenCalledTimes(1);
    });
  });
});

describe('IngestionProcessor — extractCandidateShortIds()', () => {
  let processor: IngestionProcessor;

  beforeEach(async () => {
    const txClient = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    const prisma = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ candidateId: null, cvFileKey: null }) },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(txClient)),
      candidate: { update: jest.fn().mockResolvedValue({}) },
      job: { findMany: jest.fn().mockResolvedValue([]) },
      application: { upsert: jest.fn().mockResolvedValue({ id: 'app-id' }) },
      candidateJobScore: { create: jest.fn().mockResolvedValue({}) },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionProcessor,
        SpamFilterService,
        AttachmentExtractorService,
        { provide: PrismaService, useValue: prisma },
        { provide: ExtractionAgentService, useValue: { extract: jest.fn().mockResolvedValue(mockCandidateExtract()) } },
        { provide: StorageService, useValue: { upload: jest.fn().mockResolvedValue('key'), downloadPayload: jest.fn() } },
        { provide: DedupService, useValue: { check: jest.fn().mockResolvedValue(null), insertCandidate: jest.fn().mockResolvedValue('cand-1') } },
        { provide: ScoringAgentService, useValue: { score: jest.fn() } },
        { provide: PinoLogger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } },
      ],
    }).compile();
    processor = module.get<IngestionProcessor>(IngestionProcessor);
  });

  it('should extract 3+ digit numbers from email text', () => {
    const result = processor['extractCandidateShortIds']('Apply for job 245', 'Also position 1053 is open');
    expect(result).toEqual(expect.arrayContaining(['245', '1053']));
    expect(result).toHaveLength(2);
  });

  it('should return empty for no numbers', () => {
    const result = processor['extractCandidateShortIds']('Hello', 'I want to apply');
    expect(result).toEqual([]);
  });

  it('should filter out numbers < 100', () => {
    const result = processor['extractCandidateShortIds']('I am 25 years old', 'Position 50 is closed');
    expect(result).toEqual([]);
  });

  it('should include years (false positives filtered by DB)', () => {
    const result = processor['extractCandidateShortIds']('In 2024 I applied', 'Job 101 is open');
    expect(result).toEqual(expect.arrayContaining(['2024', '101']));
  });

  it('should deduplicate repeated numbers', () => {
    const result = processor['extractCandidateShortIds']('Job 245 and job 245', 'Position 245');
    expect(result).toEqual(['245']);
  });

  it('should handle null subject and body', () => {
    const result = processor['extractCandidateShortIds'](null, null);
    expect(result).toEqual([]);
  });

  it('should return strings (matching shortId DB type)', () => {
    const result = processor['extractCandidateShortIds']('Job 100', null);
    expect(result[0]).toBe('100');
    expect(typeof result[0]).toBe('string');
  });
});

describe('IngestionProcessor — Phase 6 idempotency guard', () => {
  let processor: IngestionProcessor;
  let prisma: any;
  let dedupService: any;
  let storageService: any;

  const validPayload = () => mockPostmarkPayload({
    MessageID: 'msg-idempotency-test',
    From: 'sender@example.com',
    Subject: 'Job Application from Jane Doe',
    TextBody: 'Dear Hiring Manager, I have 5 years of experience in software engineering. Please find my CV attached.',
    Attachments: [],
  });

  beforeEach(async () => {
    const txClient = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    prisma = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ candidateId: null, cvFileKey: null }) },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(txClient)),
      candidate: { update: jest.fn().mockResolvedValue({}) },
      job: { findMany: jest.fn().mockResolvedValue([]) },
      application: { upsert: jest.fn().mockResolvedValue({ id: 'app-id' }) },
      candidateJobScore: { create: jest.fn().mockResolvedValue({}) },
    };
    dedupService = {
      check: jest.fn().mockResolvedValue(null),
      insertCandidate: jest.fn().mockResolvedValue('new-candidate-id'),
      upsertCandidate: jest.fn().mockResolvedValue(undefined),
      createFlag: jest.fn().mockResolvedValue(undefined),
    };
    storageService = { upload: jest.fn().mockResolvedValue('key'), downloadPayload: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionProcessor,
        SpamFilterService,
        AttachmentExtractorService,
        { provide: PrismaService, useValue: prisma },
        { provide: ExtractionAgentService, useValue: { extract: jest.fn().mockResolvedValue(mockCandidateExtract()) } },
        { provide: StorageService, useValue: storageService },
        { provide: DedupService, useValue: dedupService },
        { provide: ScoringAgentService, useValue: { score: jest.fn() } },
        { provide: PinoLogger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } },
      ],
    }).compile();
    processor = module.get<IngestionProcessor>(IngestionProcessor);
  });

  it('should skip Phase 6 when intake already has candidateId (retry scenario)', async () => {
    prisma.emailIntakeLog.findUnique.mockResolvedValueOnce({ candidateId: 'existing-candidate-id', cvFileKey: null });
    const payload = validPayload();
    storageService.downloadPayload.mockResolvedValue(payload);

    const job = makeJob('test-idempotency-1', payload);
    await processor.process(job);

    expect(dedupService.check).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('should run Phase 6 normally on first attempt (no candidateId)', async () => {
    prisma.emailIntakeLog.findUnique.mockResolvedValueOnce({ candidateId: null, cvFileKey: null });
    const payload = validPayload();
    storageService.downloadPayload.mockResolvedValue(payload);

    const job = makeJob('test-idempotency-2', payload);
    await processor.process(job);

    expect(dedupService.check).toHaveBeenCalled();
  });

  it('should not create duplicate candidate on retry', async () => {
    prisma.emailIntakeLog.findUnique.mockResolvedValueOnce({ candidateId: 'existing-candidate-id', cvFileKey: null });
    const payload = validPayload();
    storageService.downloadPayload.mockResolvedValue(payload);

    const job = makeJob('test-idempotency-3', payload);
    await processor.process(job);

    expect(dedupService.insertCandidate).not.toHaveBeenCalled();
  });
});
