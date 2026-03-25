import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  BadRequestException,
  NotFoundException,
  HttpCode,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { JobsService } from './jobs.service';
import { CreateJobSchema } from './dto/create-job.dto';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get()
  async findAll() {
    return this.jobsService.findAll();
  }

  @Post()
  async create(@Body() body: unknown) {
    const result = CreateJobSchema.safeParse(body);
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
    return this.jobsService.createJob(result.data);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    const result = CreateJobSchema.safeParse(body);
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
    try {
      return await this.jobsService.updateJob(id, result.data);
    } catch (error: any) {
      // Prisma P2025: record not found
      if (error?.code === 'P2025' || error instanceof NotFoundException) {
        throw new NotFoundException({
          error: {
            code: 'NOT_FOUND',
            message: 'Job not found',
          },
        });
      }
      throw error;
    }
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    try {
      await this.jobsService.deleteJob(id);
    } catch (error: any) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException({
          error: {
            code: 'NOT_FOUND',
            message: 'Job not found',
          },
        });
      }
      throw error;
    }
  }

  /**
   * Helper method to format Zod validation errors
   * Converts ZodError.issues into field error structure
   */
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
