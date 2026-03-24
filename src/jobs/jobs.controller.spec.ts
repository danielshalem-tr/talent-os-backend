import { JobsController } from './jobs.controller';

describe('JobsController', () => {
  let controller: JobsController;

  const mockJobsService = {
    findAll: jest.fn(),
    createJob: jest.fn(),
  };

  beforeEach(() => {
    controller = new JobsController(mockJobsService as any);
  });

  describe('POST /jobs', () => {
    it.todo('D-06: calls jobsService.createJob with validated dto');
    it.todo('D-08: returns 400 when title is missing');
    it.todo('D-08: returns 400 when answerType is invalid enum value');
    it.todo('D-08: returns 201 with created job on valid payload');
  });
});
