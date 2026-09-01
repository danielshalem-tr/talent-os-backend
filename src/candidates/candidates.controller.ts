import 'multer';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { SessionGuard } from '../auth/session.guard';
import { CandidatesService } from './candidates.service';
import type { CandidateFilter } from './candidates.service';
import { CreateCandidateSchema } from './dto/create-candidate.dto';
import { UpdateCandidateStageSchema } from './dto/update-candidate-stage.dto';
import { UpdateCandidateSchema } from './dto/update-candidate.dto';
import { StageSummarySchema } from './dto/stage-summary.dto';
import { RejectCandidateSchema } from './dto/reject-candidate.dto';
import { CandidateResponse } from './dto/candidate-response.dto';
import { BulkAssignService } from '../bulk-assign/bulk-assign.service';
import { BulkAssignSchema } from './dto/bulk-assign.dto';

// Content types we will echo back verbatim on the same-origin CV serve. Anything
// else is forced to a non-executable octet-stream so a maliciously-stored
// text/html or image/svg+xml object cannot run as stored XSS in our origin.
const SERVABLE_CV_CONTENT_TYPES = new Set<string>([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

@UseGuards(SessionGuard)
@Controller('candidates')
export class CandidatesController {
  constructor(
    private readonly candidatesService: CandidatesService,
    private readonly bulkAssignService: BulkAssignService,
  ) {}

  /**
   * Retrieve lightweight counts for dashboard alerts
   * @returns { total, duplicates, unassigned } for the active candidate pool
   */
  @Get('counts')
  async getCounts(@Req() req: Request): Promise<{ total: number; duplicates: number; unassigned: number }> {
    const tenantId = req.session!.org;
    return this.candidatesService.getCounts(tenantId);
  }

  /**
   * Retrieve all candidates for the tenant
   * @param q      Optional search query (name, email, role)
   * @param filter  Optional filter: all, duplicates
   * @param job_id  Optional job UUID — filters candidates linked to a specific job (used by Kanban board)
   * @param created_within_days Optional integer 1–3650 — only candidates created in the last N days
   * @returns Candidates with hiring stage info for Kanban board rendering
   */
  @Get()
  async findAll(
    @Req() req: Request,
    @Query('q') q?: string,
    @Query('filter') filter?: CandidateFilter,
    @Query('job_id') jobId?: string,
    @Query('unassigned') unassigned?: string,
    @Query('created_within_days') createdWithinDays?: string,
  ): Promise<{ candidates: CandidateResponse[]; total: number }> {
    const tenantId = req.session!.org;
    const unassignedBool = unassigned === 'true';
    return this.candidatesService.findAll(tenantId, q, filter, jobId, unassignedBool, createdWithinDays);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Req() req: Request): Promise<CandidateResponse> {
    const tenantId = req.session!.org;
    return this.candidatesService.findOne(id, tenantId);
  }

  @Get(':id/cv-url')
  async getCvUrl(@Param('id') candidateId: string, @Req() req: Request) {
    const tenantId = req.session!.org;
    return this.candidatesService.getCvPresignedUrl(candidateId, tenantId);
  }

  /**
   * Stream the CV bytes same-origin so the browser can render Word/PDF files
   * in-page (docx-preview) without an R2 CORS dependency. Tenant-scoped via SessionGuard.
   */
  @Get(':id/cv-file')
  async getCvFile(@Param('id') candidateId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const tenantId = req.session!.org;
    const { body, contentType, filename } = await this.candidatesService.getCvBytes(candidateId, tenantId);
    // Never trust the stored MIME type for a same-origin inline serve.
    const safeContentType = SERVABLE_CV_CONTENT_TYPES.has(contentType) ? contentType : 'application/octet-stream';
    res.setHeader('Content-Type', safeContentType);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', body.length);
    // Defense in depth: stop MIME sniffing and forbid any script/embed execution
    // even if a non-CV content type ever slips through.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(body);
  }

  /**
   * Create a new candidate with file upload
   * Auto-assigns candidate to the first hiring stage of the specified job
   * @returns Newly created candidate with assigned hiring stage
   */
  @Post()
  @UseInterceptors(FileInterceptor('cv_file'))
  async create(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const tenantId = req.session!.org;
    const result = CreateCandidateSchema.safeParse(body);
    if (!result.success) {
      const fieldErrors = this.formatZodErrors(result.error);
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: fieldErrors,
        },
      });
    }
    return this.candidatesService.createCandidate(result.data, file, tenantId);
  }

  /**
   * Assign many candidates to one job and score each of them.
   * Runs on the `candidate-assign` BullMQ queue — up to 200 scoring calls will not fit
   * in an HTTP request, so this returns as soon as the work is queued and the UI
   * refreshes over SWR.
   *
   * Idempotent per (candidate, job): re-running skips nothing but rewrites the same rows.
   * Candidates already assigned elsewhere are reassigned. A candidate who already has a
   * stage on the target job keeps it — voice auto-advance always wins.
   */
  @Post('bulk-assign')
  @HttpCode(202)
  async bulkAssign(@Body() body: unknown, @Req() req: Request): Promise<{ queued: number }> {
    const tenantId = req.session!.org;
    const result = BulkAssignSchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: this.formatZodErrors(result.error) },
      });
    }
    return this.bulkAssignService.enqueue(tenantId, result.data);
  }

  /**
   * Update a candidate's hiring stage (used by Kanban drag-and-drop)
   * Validates the stage belongs to the candidate's linked job.
   * Updates both candidate.hiringStageId and application.jobStageId atomically.
   */
  @Patch(':id/stage')
  async updateStage(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<{ success: boolean }> {
    const tenantId = req.session!.org;
    const result = UpdateCandidateStageSchema.safeParse(body);
    if (!result.success) {
      const fieldErrors = this.formatZodErrors(result.error);
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: fieldErrors,
        },
      });
    }
    await this.candidatesService.updateStage(id, result.data, tenantId);
    return { success: true };
  }

  /**
   * Hard-delete a candidate and all related data:
   * - DuplicateFlag rows (both candidateId and matchedCandidateId sides)
   * - EmailIntakeLog references (nullified)
   * - Applications + CandidateJobScores (cascade)
   */
  @Delete(':id')
  @HttpCode(204)
  async delete(@Param('id') id: string, @Req() req: Request): Promise<void> {
    const tenantId = req.session!.org;
    await this.candidatesService.deleteCandidate(id, tenantId);
  }

  /**
   * Update candidate profile fields and/or assign to a job pipeline.
   * - If job_id is provided and candidate has no job: atomically creates Application and sets hiringStageId to first enabled stage.
   * - If job_id matches existing assignment: no-op for that field.
   * - If job_id differs from existing assignment: throws 400 ALREADY_ASSIGNED.
   * - All other fields (full_name, email, phone, current_role, location, years_experience) are optional and updated independently.
   * @returns Updated CandidateResponse
   */
  @Patch(':id')
  async updateCandidate(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<CandidateResponse> {
    const tenantId = req.session!.org;
    const result = UpdateCandidateSchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: this.formatZodErrors(result.error) },
      });
    }
    return this.candidatesService.updateCandidate(id, result.data, tenantId);
  }

  /**
   * Reject a candidate — sets candidate.status = 'rejected' and updates their Application stage to 'rejected'.
   * Idempotent: safe to call multiple times.
   * @returns Updated CandidateResponse with is_rejected: true
   */
  @Post(':id/reject')
  @HttpCode(200)
  async rejectCandidate(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<CandidateResponse> {
    const tenantId = req.session!.org;
    const result = RejectCandidateSchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: this.formatZodErrors(result.error) },
      });
    }
    return this.candidatesService.rejectCandidate(id, result.data, tenantId);
  }

  /**
   * TO-58: clear a manual match-score override and return to an AI score.
   * Re-scores the assigned job immediately; nulls the score when no job/CV text.
   * @returns Updated CandidateResponse
   */
  @Post(':id/score/revert')
  @HttpCode(200)
  async revertScore(@Param('id') id: string, @Req() req: Request): Promise<CandidateResponse> {
    const tenantId = req.session!.org;
    return this.candidatesService.revertScore(id, tenantId);
  }

  /**
   * TO-56: upload a replacement CV. Re-extracts text, regenerates the AI summary,
   * and re-scores the assigned job (unless the score is manually overridden).
   * @returns Updated CandidateResponse
   */
  @Post(':id/cv')
  @UseInterceptors(FileInterceptor('cv_file'))
  async uploadCv(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ): Promise<CandidateResponse> {
    if (!file) {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'cv_file is required' } });
    }
    const tenantId = req.session!.org;
    return this.candidatesService.uploadCv(id, file, tenantId);
  }

  /**
   * Save or update a free-text summary for a specific hiring stage the candidate has gone through.
   * Upserts the CandidateStageSummary record for the (candidateId, stageId) pair.
   * The stage must belong to the candidate's currently assigned job.
   * @returns { success: true }
   */
  @Post(':id/stages/:stage_id/summary')
  @HttpCode(200)
  async saveStageSummary(
    @Param('id') id: string,
    @Param('stage_id') stageId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ success: boolean }> {
    const tenantId = req.session!.org;
    const result = StageSummarySchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: this.formatZodErrors(result.error) },
      });
    }
    return this.candidatesService.saveStageSummary(id, stageId, result.data.summary, tenantId);
  }

  /**
   * Composite action: saves the summary for the current stage AND advances the candidate to the next enabled hiring stage.
   * Stages are ordered by `order` asc; the next stage after current_stage_id is selected.
   * Throws 400 if candidate is already at the last stage.
   * @returns { success: true, hiring_stage_id: string } — the new stage UUID
   */
  @Post(':id/stages/:stage_id/advance')
  @HttpCode(200)
  async advanceWithSummary(
    @Param('id') id: string,
    @Param('stage_id') stageId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ success: boolean; hiring_stage_id: string }> {
    const tenantId = req.session!.org;
    const result = StageSummarySchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: this.formatZodErrors(result.error) },
      });
    }
    return this.candidatesService.advanceWithSummary(id, stageId, result.data.summary, tenantId);
  }

  private formatZodErrors(error: ZodError): Record<string, string[]> {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
      if (!fieldErrors[path]) {
        fieldErrors[path] = [];
      }
      fieldErrors[path].push(issue.message);
    }
    return fieldErrors;
  }
}
