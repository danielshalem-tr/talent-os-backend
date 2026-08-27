import { CanActivate, ExecutionContext, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

/**
 * Verifies `ElevenLabs-Signature: t=<unix>,v0=<hex>` by delegating to the SDK's
 * `webhooks.constructEvent` — the exact verification the Scheduler runs in production
 * (HMAC-SHA256 over `${t}.${rawBody}`, 30-minute staleness tolerance). Fails closed (401)
 * when ELEVENLABS_WEBHOOK_SECRET is unset — an unconfigured deployment must reject
 * webhooks, not accept them.
 */
@Injectable()
export class ElevenLabsWebhookGuard implements CanActivate {
  // constructEvent does pure local HMAC math — no HTTP — so a placeholder API key is fine
  // and the API process needs no ELEVENLABS_API_KEY just to receive webhooks.
  private readonly verifier = new ElevenLabsClient({ apiKey: 'webhook-verification-only' });

  constructor(@Optional() private readonly configService: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      rawBody?: Buffer;
    }>();

    const secret = this.configService.get<string>('ELEVENLABS_WEBHOOK_SECRET');
    if (!secret) throw new UnauthorizedException('ElevenLabs webhook secret not configured');

    const header = request.headers['elevenlabs-signature'];
    if (!header) throw new UnauthorizedException('Missing ElevenLabs-Signature header');

    if (!request.rawBody) throw new UnauthorizedException('Missing raw body');

    try {
      await this.verifier.webhooks.constructEvent(request.rawBody.toString('utf8'), header, secret);
      return true;
    } catch {
      // Malformed header, stale timestamp, or signature mismatch — same 401 for all.
      throw new UnauthorizedException('Invalid ElevenLabs webhook signature');
    }
  }
}
