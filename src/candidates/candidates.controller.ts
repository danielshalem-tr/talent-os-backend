import {
  BadRequestException,
  Body,
  Controller,
  Get,
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

@Controller('candidates')
export class CandidatesController {
  constructor(private readonly candidatesService: CandidatesService) {}

  @Get()
  async findAll(
    @Query('q') q?: string,
    @Query('filter') filter?: CandidateFilter,
  ) {
    return this.candidatesService.findAll(q, filter);
  }

  @Post()
  @UseInterceptors(FileInterceptor('cv_file'))
  async create(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ) {
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
