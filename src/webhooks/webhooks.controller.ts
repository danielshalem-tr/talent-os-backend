import { Controller, Post, Get, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { WebhooksService } from './webhooks.service';
import { MailgunRawBodySchema, parseMailgunPayload } from './dto/mailgun-payload.dto';
import { MailgunAuthGuard } from './guards/mailgun-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import type { MailgunRequest } from './multipart';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  // @Public(): no session — inbound Mailgun webhook is authenticated by HMAC signature
  // (MailgunAuthGuard), not a session cookie. Marks this route to bypass the global SessionGuard;
  // MailgunAuthGuard + ThrottlerGuard still run.
  //
  // @Throttle: everything arrives from a handful of Mailgun egress IPs, so the app-wide
  // 100/min/IP limit throttled Mailgun itself during bursts and retry storms. The HMAC guard
  // is the real gate; the limit here only stops a runaway sender.
  @Public()
  @UseGuards(MailgunAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 1000, ttl: 60_000 } })
  @Post('email')
  @HttpCode(HttpStatus.OK)
  async ingestEmail(@Req() req: MailgunRequest): Promise<{ status: string }> {
    const files = (req.files ?? []) as Express.Multer.File[];
    // Both rejections answer 200: the request IS from Mailgun (HMAC passed) and will never parse
    // differently on retry. The row in email_intake_log is the audit trail.
    if (req.multerError) {
      return this.webhooksService.recordRejected(
        req.body ?? {},
        `multipart rejected: ${req.multerError.code ?? req.multerError.message}`,
      );
    }
    const result = MailgunRawBodySchema.safeParse(req.body);
    if (!result.success) {
      return this.webhooksService.recordRejected(
        req.body ?? {},
        `payload rejected: ${JSON.stringify(result.error.flatten().fieldErrors)}`,
      );
    }
    const normalized = parseMailgunPayload(result.data, files);
    return this.webhooksService.enqueue(normalized, files);
  }

  // Public service-health probe — no session required.
  @Public()
  @Get('health')
  async health(): Promise<{ status: string; db: string; redis: string }> {
    return this.webhooksService.checkHealth();
  }
}
