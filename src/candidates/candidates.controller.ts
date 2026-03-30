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
import { CandidateResponse } from './dto/candidate-response.dto';

@Controller('candidates')
export class CandidatesController {
  constructor(private readonly candidatesService: CandidatesService) {}

  /**
   * Retrieve all candidates for the tenant
   * @param q      Optional search query (name, email, role)
   * @param filter  Optional filter: all, high-score, available, referred, duplicates
   * @param job_id  Optional job UUID — filters candidates linked to a specific job (used by Kanban board)
   * @returns Candidates with hiring stage info for Kanban board rendering
   */
  @Get()
  async findAll(
    @Query('q') q?: string,
    @Query('filter') filter?: CandidateFilter,
    @Query('job_id') jobId?: string,
  ): Promise<{ candidates: CandidateResponse[]; total: number }> {
    return this.candidatesService.findAll(q, filter, jobId);
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
