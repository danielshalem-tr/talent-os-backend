import { Test, TestingModule } from '@nestjs/testing';
import { IngestionProcessor } from './ingestion.processor';
import { mockPostmarkPayload } from './services/spam-filter.service.spec';

// Mock services that don't exist yet (Plans 03-01 and 03-02 create them)
const mockSpamFilterService = { check: jest.fn() };
const mockAttachmentExtractorService = { extract: jest.fn() };
const mockPrismaService = {
  emailIntakeLog: {
    update: jest.fn(),
  },
};
const mockConfigService = { get: jest.fn().mockReturnValue('test-tenant-id') };

describe('IngestionProcessor', () => {
  let processor: IngestionProcessor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionProcessor,
        { provide: 'SpamFilterService', useValue: mockSpamFilterService },
        { provide: 'AttachmentExtractorService', useValue: mockAttachmentExtractorService },
        { provide: 'PrismaService', useValue: mockPrismaService },
        { provide: 'ConfigService', useValue: mockConfigService },
      ],
    })
      .overrideProvider(IngestionProcessor)
      .useValue({
        process: jest.fn(),
      })
      .compile();

    processor = module.get<IngestionProcessor>(IngestionProcessor);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // PROC-06: When spam filter returns { isSpam: true }, processor updates status to 'spam' and stops
  it.todo('hard reject updates status');

  // PROC-06: When spam filter returns { isSpam: false }, processor updates status to 'processing' and continues
  it.todo('pass filter updates status');
});
