// Integration test stubs for Phase 10 — backward compatibility and end-to-end POST /jobs
// Guards: Application.stage field, Job.description/requirements fields, no ScoringAgent coupling

describe('Phase 10 integration', () => {
  describe('backward compatibility', () => {
    it.todo('D-01: Job.description field still exists and is readable after migration');
    it.todo('D-01: Job.requirements[] still exists and is readable after migration');
    it.todo('D-02: Application.stage field still returned by ApplicationsService.findAll()');
    it.todo('D-02: Application.jobStageId is nullable and does not break findAll() on existing applications');
    it.todo('D-03: ScoringAgentService is not imported or called from JobsService');
  });
  describe('POST /jobs end-to-end', () => {
    it.todo('D-06: job created with hiringStages and screeningQuestions in single operation');
    it.todo('D-07: job created with default stages when hiringStages omitted');
  });
});
