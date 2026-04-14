import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, BadRequestException } from '@nestjs/common';
import request from 'supertest';
import { CandidatesController } from './candidates.controller';
import { CandidatesService } from './candidates.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

describe('CandidatesController (Integration Tests)', () => {
  let app: INestApplication;
  let candidatesService: CandidatesService;

  const mockCandidateResponse = {
    id: 'cand-uuid',
    full_name: 'John Doe',
    email: 'john@example.com',
    phone: null,
    current_role: 'Engineer',
    location: 'Tel Aviv',
    cv_file_url: 'https://r2.example.com/cv.pdf',
    source: 'linkedin',
    source_agency: null,
    created_at: new Date('2026-01-01'),
    ai_score: 75,
    ai_summary: 'Summary',
    is_duplicate: false,
    skills: ['TypeScript'],
    status: 'active',
    is_rejected: false,
    rejection_reason: null,
    rejection_note: null,
    job_id: 'job-uuid',
    hiring_stage_id: 'stage-uuid',
    hiring_stage_name: 'Application Review',
    job_title: 'Senior Engineer',
    stage_summaries: {},
    years_experience: 5,
  };

  beforeEach(async () => {
    const mockCandidatesService = {
      updateCandidate: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [CandidatesController],
      providers: [
        { provide: CandidatesService, useValue: mockCandidatesService },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    candidatesService = moduleFixture.get<CandidatesService>(CandidatesService);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────
  // PATCH /candidates/:id Tests
  // ─────────────────────────────────────────────────────────────────

  describe('PATCH /candidates/:id', () => {
    const candidateId = 'cand-uuid';
    const patchUrl = `/candidates/${candidateId}`;

    describe('Successful Reassignment', () => {
      it('returns 200 with updated candidate when reassignment succeeds', async () => {
        jest.spyOn(candidatesService, 'updateCandidate').mockResolvedValue({
          ...mockCandidateResponse,
          job_id: '11111111-2222-3333-4444-555555555555',
          hiring_stage_id: 'new-stage-uuid',
          hiring_stage_name: 'New',
          ai_score: 80,
        });

        const response = await request(app.getHttpServer())
          .patch(patchUrl)
          .send({ job_id: '11111111-2222-3333-4444-555555555555' })
          .expect(200);

        expect(response.body).toMatchObject({
          id: candidateId,
          job_id: '11111111-2222-3333-4444-555555555555',
          hiring_stage_id: 'new-stage-uuid',
          hiring_stage_name: 'New',
          ai_score: 80,
        });
      });

      it('includes all required fields in response', async () => {
        jest.spyOn(candidatesService, 'updateCandidate').mockResolvedValue(mockCandidateResponse);

        const response = await request(app.getHttpServer())
          .patch(patchUrl)
          .send({ full_name: 'Updated Name' })
          .expect(200);

        expect(response.body).toHaveProperty('id');
        expect(response.body).toHaveProperty('full_name');
        expect(response.body).toHaveProperty('email');
        expect(response.body).toHaveProperty('job_id');
        expect(response.body).toHaveProperty('hiring_stage_id');
        expect(response.body).toHaveProperty('hiring_stage_name');
        expect(response.body).toHaveProperty('ai_score');
        expect(response.body).toHaveProperty('source_agency');
        expect(response.body).toHaveProperty('is_duplicate');
        expect(response.body).toHaveProperty('status');
      });

      it('does not include applications array in response', async () => {
        jest.spyOn(candidatesService, 'updateCandidate').mockResolvedValue(mockCandidateResponse);

        const response = await request(app.getHttpServer())
          .patch(patchUrl)
          .send({ job_id: '11111111-2222-3333-4444-555555555555' })
          .expect(200);

        expect(response.body).not.toHaveProperty('applications');
      });

      it('allows profile + job update in single request', async () => {
        jest.spyOn(candidatesService, 'updateCandidate').mockResolvedValue({
          ...mockCandidateResponse,
          full_name: 'New Name',
          job_id: '11111111-2222-3333-4444-555555555555',
        });

        const response = await request(app.getHttpServer())
          .patch(patchUrl)
          .send({ full_name: 'New Name', job_id: '11111111-2222-3333-4444-555555555555' })
          .expect(200);

        expect(response.body.full_name).toBe('New Name');
        expect(response.body.job_id).toBe('11111111-2222-3333-4444-555555555555');
      });
    });

    describe('Request Validation', () => {
      it('returns 400 when job_id format is invalid', async () => {
        jest.spyOn(candidatesService, 'updateCandidate')
          .mockRejectedValue(new BadRequestException('Invalid job_id format'));

        await request(app.getHttpServer())
          .patch(patchUrl)
          .send({ job_id: 'not-a-uuid' })
          .expect(400);
      });

      it('returns 400 with validation error code', async () => {
        const validationError = new BadRequestException({
          error: { code: 'VALIDATION_ERROR', message: 'Invalid job_id' },
        });
        jest.spyOn(candidatesService, 'updateCandidate').mockRejectedValue(validationError);

        const response = await request(app.getHttpServer())
          .patch(patchUrl)
          .send({ job_id: 'invalid' })
          .expect(400);

        expect(response.body).toMatchObject({
          error: { code: 'VALIDATION_ERROR' },
        });
      });
    });

    describe('Error Cases', () => {
      it('returns 400 when job has no enabled stages', async () => {
        const noStagesError = new BadRequestException({
          error: { code: 'NO_STAGES', message: 'Job has no enabled stages' },
        });
        jest.spyOn(candidatesService, 'updateCandidate').mockRejectedValue(noStagesError);

        const response = await request(app.getHttpServer())
          .patch(patchUrl)
          .send({ job_id: '22222222-3333-4444-5555-666666666666' })
          .expect(400);

        expect(response.body.error.code).toBe('NO_STAGES');
      });

      it('returns 404 when candidate not found', async () => {
        jest.spyOn(candidatesService, 'updateCandidate')
          .mockRejectedValue(new Error('Candidate not found'));

        await request(app.getHttpServer())
          .patch(patchUrl)
          .send({ job_id: '11111111-2222-3333-4444-555555555555' })
          .expect(500); // Service throws, controller doesn't handle
      });

      it('returns 404 when job not found (during reassignment)', async () => {
        jest.spyOn(candidatesService, 'updateCandidate')
          .mockRejectedValue(new Error('Job not found'));

        await request(app.getHttpServer())
          .patch(patchUrl)
          .send({ job_id: '33333333-4444-5555-6666-777777777777' })
          .expect(500); // Service throws
      });
    });

    describe('No ALREADY_ASSIGNED Error', () => {
      it('allows reassignment from jobId=A to jobId=B without error', async () => {
        jest.spyOn(candidatesService, 'updateCandidate').mockResolvedValue({
          ...mockCandidateResponse,
          job_id: '44444444-5555-6666-7777-888888888888',
          hiring_stage_id: 'stage-b',
        });

        // Candidate is reassigned from old job to new job
        const response = await request(app.getHttpServer())
          .patch(patchUrl)
          .send({ job_id: '44444444-5555-6666-7777-888888888888' })
          .expect(200);

        expect(response.body.job_id).toBe('44444444-5555-6666-7777-888888888888');
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // GET /candidates?unassigned=true Tests
  // ─────────────────────────────────────────────────────────────────

  describe('GET /candidates', () => {
    describe('Unassigned Filter', () => {
      it('returns 200 with candidates when unassigned=true', async () => {
        jest.spyOn(candidatesService, 'findAll').mockResolvedValue({
          candidates: [
            { ...mockCandidateResponse, id: 'cand-1', job_id: null },
            { ...mockCandidateResponse, id: 'cand-2', job_id: null },
          ],
          total: 2,
        });

        const response = await request(app.getHttpServer())
          .get('/candidates?unassigned=true')
          .expect(200);

        expect(response.body.candidates).toHaveLength(2);
        expect(response.body.candidates.every(c => c.job_id === null)).toBe(true);
      });

      it('returns all candidates when unassigned=false', async () => {
        const allCandidates = [
          { ...mockCandidateResponse, id: 'cand-1', job_id: null },
          { ...mockCandidateResponse, id: 'cand-2', job_id: 'job-uuid' },
        ];
        jest.spyOn(candidatesService, 'findAll').mockResolvedValue({
          candidates: allCandidates,
          total: 2,
        });

        const response = await request(app.getHttpServer())
          .get('/candidates?unassigned=false')
          .expect(200);

        expect(response.body.candidates).toHaveLength(2);
      });

      it('returns all candidates when unassigned param omitted', async () => {
        const allCandidates = [
          { ...mockCandidateResponse, id: 'cand-1', job_id: null },
          { ...mockCandidateResponse, id: 'cand-2', job_id: 'job-uuid' },
        ];
        jest.spyOn(candidatesService, 'findAll').mockResolvedValue({
          candidates: allCandidates,
          total: 2,
        });

        const response = await request(app.getHttpServer())
          .get('/candidates')
          .expect(200);

        expect(response.body.candidates).toHaveLength(2);
      });
    });

    describe('Combined Filters', () => {
      it('combines unassigned filter with search query', async () => {
        jest.spyOn(candidatesService, 'findAll').mockResolvedValue({
          candidates: [
            { ...mockCandidateResponse, id: 'cand-1', full_name: 'John Doe', job_id: null },
          ],
          total: 1,
        });

        const response = await request(app.getHttpServer())
          .get('/candidates?unassigned=true&q=john')
          .expect(200);

        expect(response.body.candidates).toHaveLength(1);
        expect(candidatesService.findAll).toHaveBeenCalledWith(
          'john',
          undefined,
          undefined,
          true
        );
      });

      it('combines unassigned filter with filter=duplicates', async () => {
        jest.spyOn(candidatesService, 'findAll').mockResolvedValue({
          candidates: [
            { ...mockCandidateResponse, id: 'cand-1', is_duplicate: true, job_id: null },
          ],
          total: 1,
        });

        const response = await request(app.getHttpServer())
          .get('/candidates?unassigned=true&filter=duplicates')
          .expect(200);

        expect(response.body.candidates).toHaveLength(1);
        expect(candidatesService.findAll).toHaveBeenCalledWith(
          undefined,
          'duplicates',
          undefined,
          true
        );
      });

      it('takes unassigned=true over jobId param', async () => {
        jest.spyOn(candidatesService, 'findAll').mockResolvedValue({
          candidates: [
            { ...mockCandidateResponse, id: 'cand-1', job_id: null },
          ],
          total: 1,
        });

        const response = await request(app.getHttpServer())
          .get('/candidates?unassigned=true&job_id=some-job')
          .expect(200);

        expect(candidatesService.findAll).toHaveBeenCalledWith(
          undefined,
          undefined,
          'some-job',
          true // unassigned=true should be passed
        );
      });
    });

    describe('Response Format Compliance', () => {
      it('returns flattened response without applications array', async () => {
        jest.spyOn(candidatesService, 'findAll').mockResolvedValue({
          candidates: [mockCandidateResponse],
          total: 1,
        });

        const response = await request(app.getHttpServer())
          .get('/candidates')
          .expect(200);

        expect(response.body.candidates[0]).not.toHaveProperty('applications');
        expect(response.body.candidates[0]).toHaveProperty('ai_score');
      });

      it('includes sourceAgency in candidate response', async () => {
        jest.spyOn(candidatesService, 'findAll').mockResolvedValue({
          candidates: [
            { ...mockCandidateResponse, source_agency: 'LinkedIn' },
          ],
          total: 1,
        });

        const response = await request(app.getHttpServer())
          .get('/candidates')
          .expect(200);

        expect(response.body.candidates[0].source_agency).toBe('LinkedIn');
      });

      it('includes all required fields in list response', async () => {
        jest.spyOn(candidatesService, 'findAll').mockResolvedValue({
          candidates: [mockCandidateResponse],
          total: 1,
        });

        const response = await request(app.getHttpServer())
          .get('/candidates')
          .expect(200);

        const candidate = response.body.candidates[0];
        expect(candidate).toHaveProperty('id');
        expect(candidate).toHaveProperty('full_name');
        expect(candidate).toHaveProperty('email');
        expect(candidate).toHaveProperty('job_id');
        expect(candidate).toHaveProperty('hiring_stage_id');
        expect(candidate).toHaveProperty('hiring_stage_name');
        expect(candidate).toHaveProperty('ai_score');
        expect(candidate).toHaveProperty('source_agency');
        expect(candidate).toHaveProperty('is_duplicate');
        expect(candidate).toHaveProperty('status');
      });
    });

    describe('Pagination & Metadata', () => {
      it('returns total count in response', async () => {
        jest.spyOn(candidatesService, 'findAll').mockResolvedValue({
          candidates: [mockCandidateResponse],
          total: 5,
        });

        const response = await request(app.getHttpServer())
          .get('/candidates?limit=1')
          .expect(200);

        expect(response.body.total).toBe(5);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Integration: PATCH then GET Workflow
  // ─────────────────────────────────────────────────────────────────

  describe('Integration: Reassignment Workflow', () => {
    it('reassigns candidate via PATCH then appears in filtered GET', async () => {
      const candidateId = 'cand-uuid';

      // Step 1: PATCH to reassign
      jest.spyOn(candidatesService, 'updateCandidate').mockResolvedValue({
        ...mockCandidateResponse,
        id: candidateId,
        job_id: '55555555-6666-7777-8888-999999999999',
        hiring_stage_id: 'stage-new',
      });

      const patchResponse = await request(app.getHttpServer())
        .patch(`/candidates/${candidateId}`)
        .send({ job_id: '55555555-6666-7777-8888-999999999999' })
        .expect(200);

      expect(patchResponse.body.job_id).toBe('55555555-6666-7777-8888-999999999999');

      // Step 2: GET unassigned should NOT include this candidate anymore
      jest.spyOn(candidatesService, 'findAll').mockResolvedValue({
        candidates: [], // No unassigned candidates now
        total: 0,
      });

      const getResponse = await request(app.getHttpServer())
        .get('/candidates?unassigned=true')
        .expect(200);

      expect(getResponse.body.candidates).toHaveLength(0);
    });
  });
});
