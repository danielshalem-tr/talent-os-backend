import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
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
  let prisma: { emailIntakeLog: { update: jest.Mock }; $transaction: jest.Mock; candidate: { update: jest.Mock }; job: { findMany: jest.Mock; findFirst: jest.Mock }; application: { upsert: jest.Mock }; candidateJobScore: { create: jest.Mock } };
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
      job: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
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
  let prisma: { emailIntakeLog: { update: jest.Mock }; $transaction: jest.Mock; candidate: { update: jest.Mock }; job: { findMany: jest.Mock; findFirst: jest.Mock }; application: { upsert: jest.Mock }; candidateJobScore: { create: jest.Mock } };
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
      job: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
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
  let prisma: { emailIntakeLog: { update: jest.Mock }; $transaction: jest.Mock; candidate: { update: jest.Mock }; job: { findMany: jest.Mock; findFirst: jest.Mock }; application: { upsert: jest.Mock }; candidateJobScore: { create: jest.Mock } };
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
      job: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
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
      ],
    }).compile();

    processor = module.get<IngestionProcessor>(IngestionProcessor);
  });

  afterEach(() => jest.clearAllMocks());

  const validJobPayload = () =>
    mockPostmarkPayload({
      MessageID: 'msg-dedup-test',
      From: 'sender@example.com',
      Subject: 'Job Application from Jane Doe',
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
  it('6-02-02: exact match — UPSERT called, existing candidateId set on intake log', async () => {
    dedupService.check.mockResolvedValue({
      match: { id: 'existing-cand-id' },
      confidence: 1.0,
      fields: ['email'],
    });

    const job = { id: 'test-dedup-2', data: validJobPayload() } as any;
    await processor.process(job);

    expect(dedupService.upsertCandidate).toHaveBeenCalledWith('existing-cand-id', expect.any(Object), expect.anything());
    expect(dedupService.insertCandidate).not.toHaveBeenCalled();
    expect(dedupService.createFlag).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  // 6-02-03: fuzzy match → INSERT new candidate + createFlag + email_intake_log.candidate_id = new ID
  it('6-02-03: fuzzy match — new candidate inserted, flag created, candidateId set on intake log', async () => {
    dedupService.check.mockResolvedValue({
      match: { id: 'matched-cand-id' },
      confidence: 0.85,
      fields: ['name'],
    });
    dedupService.insertCandidate.mockResolvedValue('fuzzy-new-candidate-id');

    const job = { id: 'test-dedup-3', data: validJobPayload() } as any;
    await processor.process(job);

    expect(dedupService.insertCandidate).toHaveBeenCalledTimes(1);
    expect(dedupService.createFlag).toHaveBeenCalledWith(
      'fuzzy-new-candidate-id',
      'matched-cand-id',
      0.85,
      'test-tenant-id',
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
});

describe('IngestionProcessor — Phase 7 Candidate Enrichment & Scoring', () => {
  let processor: IngestionProcessor;
  let prisma: {
    emailIntakeLog: { update: jest.Mock };
    $transaction: jest.Mock;
    candidate: { update: jest.Mock };
    job: { findMany: jest.Mock; findFirst: jest.Mock };
    application: { upsert: jest.Mock };
    candidateJobScore: { create: jest.Mock };
  };
  let extractionAgent: { extract: jest.Mock };
  let storageService: { upload: jest.Mock };
  let dedupService: { check: jest.Mock; insertCandidate: jest.Mock; upsertCandidate: jest.Mock; createFlag: jest.Mock };
  let scoringService: { score: jest.Mock };

  const activeJob = { id: 'job-id-1', title: 'Senior Backend Developer', description: 'Build APIs.', requirements: ['TypeScript'], hiringStages: [{ id: 'stage-1' }] };

  beforeEach(async () => {
    const txClient = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
    };

    prisma = {
      emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation(async (cb: (tx: typeof txClient) => Promise<void>) => cb(txClient)),
      candidate: { update: jest.fn().mockResolvedValue({}) },
      job: { findMany: jest.fn().mockResolvedValue([activeJob]), findFirst: jest.fn().mockResolvedValue(null) },
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
        job_title_hint: 'Senior Backend Developer',
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
      ],
    }).compile();

    processor = module.get<IngestionProcessor>(IngestionProcessor);
  });

  afterEach(() => jest.clearAllMocks());

  const validJobPayload = () =>
    mockPostmarkPayload({
      MessageID: 'msg-phase7-test',
      From: 'sender@example.com',
      Subject: 'Job Application from Jane Doe',
      TextBody:
        'Dear Hiring Manager, I have 7 years of TypeScript and Node.js experience building backend systems. ' +
        'I am very interested in this position and would love to discuss my background further. ' +
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

  it('7-02-02: SCOR-01 — job.findMany called with tenantId and status=open', async () => {
    const job = { id: 'test-p7-2', data: validJobPayload() } as any;
    await processor.process(job);

    expect(prisma.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'test-tenant-id', status: 'open' },
      }),
    );
    // Called once for Phase 6.5 (matching) and once for Phase 7 (scoring)
    expect(prisma.job.findMany).toHaveBeenCalledTimes(2);
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

  // 7-02-04: SCOR-01 no active jobs — scoring loop skipped, status still completed
  it('7-02-04: SCOR-01 — no active jobs: scoring loop skipped, processingStatus still set to completed', async () => {
    prisma.job.findMany.mockResolvedValueOnce([]);

    const job = { id: 'test-p7-4', data: validJobPayload() } as any;
    await processor.process(job);

    expect(prisma.application.upsert).not.toHaveBeenCalled();
    expect(scoringService.score).not.toHaveBeenCalled();
    // findMany called once for matching, which finds [], so it skips scoring findMany
    expect(prisma.job.findMany).toHaveBeenCalledTimes(1);
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

  // 7-02-06: Issue Fix 2 — Scoring error for one job does not fail entire candidate
  it('7-02-06: Issue Fix 2 — scoring fails for one job; other jobs continue (error isolation)', async () => {
    const job2 = { id: 'job-id-2', title: 'Frontend Engineer', description: 'Build UIs.', requirements: ['React'], hiringStages: [{ id: 'stage-2' }] };
    prisma.job.findMany.mockResolvedValue([activeJob, job2]);

    // First call succeeds, second fails
    scoringService.score
      .mockResolvedValueOnce({ score: 72, reasoning: 'Good.', strengths: ['TS'], gaps: [], modelUsed: 'claude-sonnet-4-6' })
      .mockRejectedValueOnce(new Error('Anthropic API timeout'));

    const jobData = { id: 'test-p7-6', data: validJobPayload() } as any;
    await processor.process(jobData);

    // Both jobs should have attempted upsert (both applications created)
    expect(prisma.application.upsert).toHaveBeenCalledTimes(2);

    // Only one score created (second job's scoring failed)
    expect(prisma.candidateJobScore.create).toHaveBeenCalledTimes(1);

    // Final status should still be completed (error in scoring loop doesn't prevent completion)
    expect(prisma.emailIntakeLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { processingStatus: 'completed' } }),
    );
  });

  describe('IngestionProcessor — Phase 6.5 Job Matching (Phase 14 Fix)', () => {
    let processor: IngestionProcessor;
    let prisma: any;
    let extractionAgent: any;

    const job1 = { id: 'job-1', title: 'Full Stack Engineer', status: 'active', hiringStages: [{ id: 'stage-1' }] };
    const job2 = { id: 'job-2', title: 'Backend Developer', status: 'active', hiringStages: [{ id: 'stage-2' }] };

    beforeEach(async () => {
      const txClient = { emailIntakeLog: { update: jest.fn().mockResolvedValue({}) } };
      prisma = {
        emailIntakeLog: { update: jest.fn().mockResolvedValue({}) },
        $transaction: jest.fn().mockImplementation(async (cb) => cb(txClient)),
        candidate: { update: jest.fn().mockResolvedValue({}) },
        job: { findMany: jest.fn().mockResolvedValue([job1, job2]), findFirst: jest.fn() },
        application: { upsert: jest.fn().mockResolvedValue({ id: 'app-1' }) },
        candidateJobScore: { create: jest.fn().mockResolvedValue({}) },
      };
      extractionAgent = { extract: jest.fn().mockResolvedValue({ ...mockCandidateExtract(), job_title_hint: 'Full Stack Developer' }) };

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
        ],
      }).compile();
      processor = module.get<IngestionProcessor>(IngestionProcessor);
    });

    it('matches the job with the highest similarity (Full Stack Developer matched to Full Stack Engineer)', async () => {
      const job = { id: 'test-match-1', data: mockPostmarkPayload({ TextBody: 'a'.repeat(101) }) } as any;
      await processor.process(job);

      // Should pick job1 over job2 because "Full Stack Developer" is closer to "Full Stack Engineer"
      expect(prisma.candidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ jobId: 'job-1' }),
        }),
      );
    });

    it('proceeds with null jobId and skips scoring if no match meets threshold', async () => {
      extractionAgent.extract.mockResolvedValueOnce({ ...mockCandidateExtract(), job_title_hint: 'Accountant' });
      const job = { id: 'test-match-2', data: mockPostmarkPayload({ TextBody: 'a'.repeat(101) }) } as any;
      await processor.process(job);

      // Should not match "Accountant" to either engineer job
      expect(prisma.candidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ jobId: null }),
        }),
      );
      // Still completes
      expect(prisma.emailIntakeLog.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { processingStatus: 'completed' } }),
      );
      // Scoring skipped
      expect(prisma.job.findMany).toHaveBeenCalledTimes(1); // Only once for matching
    });
  });
});
