import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JobsController } from './jobs.controller';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const mockReq = { session: { org: TENANT_ID, sub: 'user-uuid', role: 'admin' } } as any;

describe('JobsController', () => {
  const mockJobsService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
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
      const result = await controller.findAll(mockReq);
      expect(mockJobsService.findAll).toHaveBeenCalledTimes(1);
      expect(result).toBe(mockResult);
    });

    it('passes status param to service', async () => {
      const mockResult = { jobs: [], total: 0 };
      mockJobsService.findAll.mockResolvedValue(mockResult);
      await controller.findAll(mockReq, 'open');
      expect(mockJobsService.findAll).toHaveBeenCalledWith(TENANT_ID, 'open');
    });

    it('calls service with undefined when no status param', async () => {
      const mockResult = { jobs: [], total: 0 };
      mockJobsService.findAll.mockResolvedValue(mockResult);
      await controller.findAll(mockReq, undefined);
      expect(mockJobsService.findAll).toHaveBeenCalledWith(TENANT_ID, undefined);
    });
  });

  describe('GET /jobs/:id', () => {
    it('calls jobsService.findOne and returns result', async () => {
      const mockResult = { id: 'job-1', title: 'Senior Dev', hiring_flow: [], screening_questions: [] };
      mockJobsService.findOne.mockResolvedValue(mockResult);

      const result = await controller.findOne('job-1', mockReq);

      expect(mockJobsService.findOne).toHaveBeenCalledWith('job-1', TENANT_ID);
      expect(result).toBe(mockResult);
    });

    it('propagates NotFoundException when service throws it', async () => {
      mockJobsService.findOne.mockRejectedValue(
        new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Job not found' } }),
      );

      await expect(controller.findOne('nonexistent', mockReq)).rejects.toThrow(NotFoundException);
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
      await controller.create(payload, mockReq);
      expect(mockJobsService.createJob).toHaveBeenCalledTimes(1);
      expect(mockJobsService.createJob).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Software Engineer', job_type: 'full_time' }),
        TENANT_ID,
      );
    });

    it('returns 400 VALIDATION_ERROR when title is missing', async () => {
      try {
        await controller.create({}, mockReq);
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
        }, mockReq),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns 400 VALIDATION_ERROR when all hiring stages are disabled', async () => {
      try {
        await controller.create({
          title: 'Eng',
          job_type: 'full_time',
          status: 'draft',
          hiring_flow: [{ name: 'S1', order: 1, color: 'bg-zinc-400', is_enabled: false, is_custom: false }],
        }, mockReq);
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
      }
    });

    it('returns result on valid payload', async () => {
      mockJobsService.createJob.mockResolvedValue({ id: 'job-1', title: 'Eng' });
      const result = await controller.create({ title: 'Eng' }, mockReq);
      expect(result).toEqual({ id: 'job-1', title: 'Eng' });
    });
  });

  describe('PUT /jobs/:id', () => {
    it('calls jobsService.updateJob with id and validated dto', async () => {
      mockJobsService.updateJob.mockResolvedValue({ id: 'job-1', title: 'Updated' });
      const payload = { title: 'Updated', job_type: 'full_time', status: 'draft' };
      await controller.update('job-1', payload, mockReq);
      expect(mockJobsService.updateJob).toHaveBeenCalledWith('job-1', expect.objectContaining({ title: 'Updated' }), TENANT_ID);
    });

    it('returns 400 VALIDATION_ERROR when validation fails', async () => {
      await expect(controller.update('job-1', {}, mockReq)).rejects.toThrow(BadRequestException);
    });

    it('returns 404 NOT_FOUND when job not found (NotFoundException)', async () => {
      mockJobsService.updateJob.mockRejectedValue(new NotFoundException());
      try {
        await controller.update('nonexistent', { title: 'T', job_type: 'full_time', status: 'draft' }, mockReq);
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
        await controller.update('nonexistent', { title: 'T', job_type: 'full_time', status: 'draft' }, mockReq);
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundException);
      }
    });
  });

  describe('DELETE /jobs/:id', () => {
    it('calls jobsService.deleteJob with id', async () => {
      mockJobsService.deleteJob.mockResolvedValue(undefined);
      await controller.delete('job-1', mockReq);
      expect(mockJobsService.deleteJob).toHaveBeenCalledWith('job-1', TENANT_ID);
    });

    it('returns 404 NOT_FOUND when job not found', async () => {
      mockJobsService.deleteJob.mockRejectedValue(new NotFoundException());
      try {
        await controller.delete('nonexistent', mockReq);
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
      await controller.hardDelete('job-1', mockReq);
      expect(mockJobsService.hardDeleteJob).toHaveBeenCalledWith('job-1', TENANT_ID);
    });

    it('returns 404 NOT_FOUND when job not found', async () => {
      mockJobsService.hardDeleteJob.mockRejectedValue(new NotFoundException());
      try {
        await controller.hardDelete('nonexistent', mockReq);
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
      await controller.hardDelete('job-1', mockReq);
      expect(mockJobsService.deleteJob).not.toHaveBeenCalled();
    });

    it('propagates unexpected errors without wrapping them', async () => {
      mockJobsService.hardDeleteJob.mockRejectedValue(new Error('Unexpected DB error'));
      await expect(controller.hardDelete('job-1', mockReq)).rejects.toThrow('Unexpected DB error');
    });
  });
});
