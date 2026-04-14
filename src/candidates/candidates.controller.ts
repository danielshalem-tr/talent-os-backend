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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ZodError } from 'zod';
import { CandidatesService } from './candidates.service';
import type { CandidateFilter } from './candidates.service';
import { CreateCandidateSchema } from './dto/create-candidate.dto';
import { UpdateCandidateStageSchema } from './dto/update-candidate-stage.dto';
import { UpdateCandidateSchema } from './dto/update-candidate.dto';
import { StageSummarySchema } from './dto/stage-summary.dto';
import { RejectCandidateSchema } from './dto/reject-candidate.dto';
import { CandidateResponse } from './dto/candidate-response.dto';

@Controller('candidates')
export class CandidatesController {
  constructor(private readonly candidatesService: CandidatesService) {}

  /**
   * Retrieve lightweight counts for dashboard alerts
   * @returns { total, duplicates, unassigned } for the active candidate pool
   */
  @Get('counts')
  async getCounts(): Promise<{ total: number; duplicates: number; unassigned: number }> {
    return this.candidatesService.getCounts();
  }

  /**
   * Retrieve all candidates for the tenant
   * @param q      Optional search query (name, email, role)
   * @param filter  Optional filter: all, duplicates
   * @param job_id  Optional job UUID — filters candidates linked to a specific job (used by Kanban board)
   * @returns Candidates with hiring stage info for Kanban board rendering
   */
  @Get()
  async findAll(
    @Query('q') q?: string,
    @Query('filter') filter?: CandidateFilter,
    @Query('job_id') jobId?: string,
    @Query('unassigned') unassigned?: string,
  ): Promise<{ candidates: CandidateResponse[]; total: number }> {
    const unassignedBool = unassigned === 'true';
    return this.candidatesService.findAll(q, filter, jobId, unassignedBool);
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<CandidateResponse> {
    return this.candidatesService.findOne(id);
  }

  @Get(':id/cv-url')
  async getCvUrl(@Param('id') candidateId: string) {
    return this.candidatesService.getCvPresignedUrl(candidateId);
  }

  /**
   * Create a new candidate with file upload
   * Auto-assigns candidate to the first hiring stage of the specified job
   * @returns Newly created candidate with assigned hiring stage
   */
  @Post()
  @UseInterceptors(FileInterceptor('cv_file'))
  async create(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
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
    return this.candidatesService.createCandidate(result.data, file);
  }

  /**
   * Update a candidate's hiring stage (used by Kanban drag-and-drop)
   * Validates the stage belongs to the candidate's linked job.
   * Updates both candidate.hiringStageId and application.jobStageId atomically.
   */
  @Patch(':id/stage')
  async updateStage(@Param('id') id: string, @Body() body: unknown): Promise<{ success: boolean }> {
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
    await this.candidatesService.updateStage(id, result.data);
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
  async delete(@Param('id') id: string): Promise<void> {
    await this.candidatesService.deleteCandidate(id);
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
  async updateCandidate(@Param('id') id: string, @Body() body: unknown): Promise<CandidateResponse> {
    const result = UpdateCandidateSchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: this.formatZodErrors(result.error) },
      });
    }
    return this.candidatesService.updateCandidate(id, result.data);
  }

  /**
   * Reject a candidate — sets candidate.status = 'rejected' and updates their Application stage to 'rejected'.
   * Idempotent: safe to call multiple times.
   * @returns Updated CandidateResponse with is_rejected: true
   */
  @Post(':id/reject')
  @HttpCode(200)
  async rejectCandidate(@Param('id') id: string, @Body() body: unknown): Promise<CandidateResponse> {
    const result = RejectCandidateSchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: this.formatZodErrors(result.error) },
      });
    }
    return this.candidatesService.rejectCandidate(id, result.data);
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
  ): Promise<{ success: boolean }> {
    const result = StageSummarySchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: this.formatZodErrors(result.error) },
      });
    }
    return this.candidatesService.saveStageSummary(id, stageId, result.data.summary);
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
  ): Promise<{ success: boolean; hiring_stage_id: string }> {
    const result = StageSummarySchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: this.formatZodErrors(result.error) },
      });
    }
    return this.candidatesService.advanceWithSummary(id, stageId, result.data.summary);
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
