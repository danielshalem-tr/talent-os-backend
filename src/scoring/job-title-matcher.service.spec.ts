import { Test, TestingModule } from '@nestjs/testing';
import { JobTitleMatcherService, JobTitleMatchResult } from './job-title-matcher.service';

jest.mock('ai', () => ({
  generateObject: jest.fn(),
}));

jest.mock('@ai-sdk/anthropic', () => ({
  anthropic: jest.fn(() => ({})),
}));

import { generateObject } from 'ai';

describe('JobTitleMatcherService', () => {
  let service: JobTitleMatcherService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [JobTitleMatcherService],
    }).compile();

    service = module.get<JobTitleMatcherService>(JobTitleMatcherService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('matchJobTitles', () => {
    // Test 1: Similar roles with seniority variation
    it('should match "Software Developer" and "Senior Software Engineer" with high confidence', async () => {
      (generateObject as jest.Mock).mockResolvedValueOnce({
        object: {
          matched: true,
          confidence: 92,
          reasoning: 'Both refer to software engineer roles; seniority differs but core skill set is the same',
        },
      });

      const result = await service.matchJobTitles(
        'Software Developer',
        'Senior Software Engineer',
        'tenant-1'
      );

      expect(result.matched).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.85);
      expect(result.confidence).toBeLessThanOrEqual(1.0);
      expect(result.reasoning).toBeDefined();
    });

    // Test 2: Similar frontend specializations
    it('should match "Frontend Engineer" and "Senior Frontend Engineer" with high confidence', async () => {
      (generateObject as jest.Mock).mockResolvedValueOnce({
        object: {
          matched: true,
          confidence: 95,
          reasoning: 'Both are frontend engineering roles; seniority level is the only difference',
        },
      });

      const result = await service.matchJobTitles(
        'Frontend Engineer',
        'Senior Frontend Engineer',
        'tenant-1'
      );

      expect(result.matched).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.90);
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });

    // Test 3: Unrelated roles
    it('should NOT match "Data Analyst" and "Software Developer"', async () => {
      (generateObject as jest.Mock).mockResolvedValueOnce({
        object: {
          matched: false,
          confidence: 15,
          reasoning: 'Data Analyst focuses on data analysis; Software Developer focuses on software engineering',
        },
      });

      const result = await service.matchJobTitles(
        'Data Analyst',
        'Software Developer',
        'tenant-1'
      );

      expect(result.matched).toBe(false);
      expect(result.confidence).toBeLessThan(0.5);
    });

    // Test 4: Completely different domains
    it('should NOT match "Product Manager" and "DevOps Engineer"', async () => {
      (generateObject as jest.Mock).mockResolvedValueOnce({
        object: {
          matched: false,
          confidence: 5,
          reasoning: 'Product Manager is a business/product role; DevOps Engineer is an infrastructure role',
        },
      });

      const result = await service.matchJobTitles(
        'Product Manager',
        'DevOps Engineer',
        'tenant-1'
      );

      expect(result.matched).toBe(false);
      expect(result.confidence).toBeLessThan(0.3);
    });

    // Test 5: Graceful fallback on error
    it('should handle network errors gracefully', async () => {
      (generateObject as jest.Mock).mockRejectedValueOnce(
        new Error('Service unavailable')
      );

      const result = await service.matchJobTitles(
        'Software Developer',
        'Senior Software Engineer',
        'tenant-1'
      );

      expect(result.matched).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.error).toBeDefined();
    });

    // Test 6: Empty or null input handling
    it('should handle empty or null inputs safely', async () => {
      const result1 = await service.matchJobTitles('', '', 'tenant-1');
      expect(result1.matched).toBe(false);
      expect(result1.confidence).toBe(0);

      const result2 = await service.matchJobTitles('Software Developer', '', 'tenant-1');
      expect(result2.matched).toBe(false);
      expect(result2.confidence).toBe(0);
    });
  });
});
