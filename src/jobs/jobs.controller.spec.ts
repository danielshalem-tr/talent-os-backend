import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JobsController } from './jobs.controller';

describe('JobsController', () => {
  const mockJobsService = {
    findAll: jest.fn(),
    createJob: jest.fn(),
    updateJob: jest.fn(),
    deleteJob: jest.fn(),
    hardDeleteJob: jest.fn(),
  };

  let controller: JobsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new JobsController(mockJobsService as any);
  });

  describe('GET /jobs', () => {
    it('calls jobsService.findAll and returns result', async () => {
      const mockResult = { jobs: [], total: 0 };
      mockJobsService.findAll.mockResolvedValue(mockResult);
      const result = await controller.findAll();
      expect(mockJobsService.findAll).toHaveBeenCalledTimes(1);
      expect(result).toBe(mockResult);
    });

    it('passes status param to service', async () => {
      const mockResult = { jobs: [], total: 0 };
      mockJobsService.findAll.mockResolvedValue(mockResult);
      await controller.findAll('open');
      expect(mockJobsService.findAll).toHaveBeenCalledWith('open');
    });

    it('calls service with undefined when no status param', async () => {
      const mockResult = { jobs: [], total: 0 };
      mockJobsService.findAll.mockResolvedValue(mockResult);
      await controller.findAll(undefined);
      expect(mockJobsService.findAll).toHaveBeenCalledWith(undefined);
    });
  });

  describe('POST /jobs', () => {
    it('calls jobsService.createJob with validated dto', async () => {
      mockJobsService.createJob.mockResolvedValue({ id: 'job-1', title: 'Software Engineer' });
      const payload = {
        title: 'Software Engineer',
        job_type: 'full_time',
        status: 'draft',
        hiring_flow: [{ name: 'Stage 1', order: 1, color: 'bg-zinc-400', is_enabled: true, is_custom: false }],
      };
      await controller.create(payload);
      expect(mockJobsService.createJob).toHaveBeenCalledTimes(1);
      expect(mockJobsService.createJob).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Software Engineer', job_type: 'full_time' }),
      );
    });

    it('returns 400 VALIDATION_ERROR when title is missing', async () => {
      try {
        await controller.create({});
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as any;
        expect(response.error.code).toBe('VALIDATION_ERROR');
        expect(response.error.message).toBe('Validation failed');
        expect(response.error.details).toHaveProperty('title');
      }
    });

    it('returns 400 when screening question type is invalid', async () => {
      await expect(
        controller.create({
          title: 'Eng',
          hiring_flow: [{ name: 'S1', order: 1, color: 'bg-zinc-400', is_enabled: true, is_custom: false }],
          screening_questions: [{ text: 'Q?', type: 'invalid_type' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns 400 VALIDATION_ERROR when all hiring stages are disabled', async () => {
      try {
        await controller.create({
          title: 'Eng',
          job_type: 'full_time',
          status: 'draft',
          hiring_flow: [{ name: 'S1', order: 1, color: 'bg-zinc-400', is_enabled: false, is_custom: false }],
        });
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
      }
    });

    it('returns result on valid payload', async () => {
      mockJobsService.createJob.mockResolvedValue({ id: 'job-1', title: 'Eng' });
      const result = await controller.create({ title: 'Eng' });
      expect(result).toEqual({ id: 'job-1', title: 'Eng' });
    });
  });

  describe('PUT /jobs/:id', () => {
    it('calls jobsService.updateJob with id and validated dto', async () => {
      mockJobsService.updateJob.mockResolvedValue({ id: 'job-1', title: 'Updated' });
      const payload = { title: 'Updated', job_type: 'full_time', status: 'draft' };
      await controller.update('job-1', payload);
      expect(mockJobsService.updateJob).toHaveBeenCalledWith('job-1', expect.objectContaining({ title: 'Updated' }));
    });

    it('returns 400 VALIDATION_ERROR when validation fails', async () => {
      await expect(controller.update('job-1', {})).rejects.toThrow(BadRequestException);
    });

    it('returns 404 NOT_FOUND when job not found (NotFoundException)', async () => {
      mockJobsService.updateJob.mockRejectedValue(new NotFoundException());
      try {
        await controller.update('nonexistent', { title: 'T', job_type: 'full_time', status: 'draft' });
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundException);
        const response = (err as NotFoundException).getResponse() as any;
        expect(response.error.code).toBe('NOT_FOUND');
      }
    });

    it('returns 404 NOT_FOUND when Prisma throws P2025', async () => {
      mockJobsService.updateJob.mockRejectedValue({ code: 'P2025' });
      try {
        await controller.update('nonexistent', { title: 'T', job_type: 'full_time', status: 'draft' });
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundException);
      }
    });
  });

  describe('DELETE /jobs/:id', () => {
    it('calls jobsService.deleteJob with id', async () => {
      mockJobsService.deleteJob.mockResolvedValue(undefined);
      await controller.delete('job-1');
      expect(mockJobsService.deleteJob).toHaveBeenCalledWith('job-1');
    });

    it('returns 404 NOT_FOUND when job not found', async () => {
      mockJobsService.deleteJob.mockRejectedValue(new NotFoundException());
      try {
        await controller.delete('nonexistent');
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundException);
        const response = (err as NotFoundException).getResponse() as any;
        expect(response.error.code).toBe('NOT_FOUND');
      }
    });
  });

  describe('DELETE /jobs/:id/hard', () => {
    it('calls jobsService.hardDeleteJob with the correct id', async () => {
      mockJobsService.hardDeleteJob.mockResolvedValue(undefined);
      await controller.hardDelete('job-1');
      expect(mockJobsService.hardDeleteJob).toHaveBeenCalledWith('job-1');
    });

    it('returns 404 NOT_FOUND when job not found', async () => {
      mockJobsService.hardDeleteJob.mockRejectedValue(new NotFoundException());
      try {
        await controller.hardDelete('nonexistent');
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundException);
        const response = (err as NotFoundException).getResponse() as any;
        expect(response.error.code).toBe('NOT_FOUND');
        expect(response.error.message).toBe('Job not found');
      }
    });

    it('does not call deleteJob (soft-delete) when hard-deleting', async () => {
      mockJobsService.hardDeleteJob.mockResolvedValue(undefined);
      await controller.hardDelete('job-1');
      expect(mockJobsService.deleteJob).not.toHaveBeenCalled();
    });

    it('propagates unexpected errors without wrapping them', async () => {
      mockJobsService.hardDeleteJob.mockRejectedValue(new Error('Unexpected DB error'));
      await expect(controller.hardDelete('job-1')).rejects.toThrow('Unexpected DB error');
    });
  });
});

