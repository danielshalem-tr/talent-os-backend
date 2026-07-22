import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT } from 'jose';

// Mints the host-vouch JWT the standalone pm-bridge Box requires (PROTOCOL.md "Auth"):
// iss = host-app API key, aud = 'pm-bridge-box', 5-minute expiry, HS256 with the
// host-app signing secret. The secret never reaches the browser — the widget calls
// GET /pmb-token per request instead.
@Injectable()
export class PmbTokenService {
  private readonly apiKey?: string;
  private readonly secret?: Uint8Array;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('PMB_API_KEY');
    const raw = config.get<string>('PMB_SIGNING_SECRET');
    this.secret = raw ? new TextEncoder().encode(raw) : undefined;
  }

  async mint(email: string): Promise<string> {
    if (!this.apiKey || !this.secret) {
      throw new ServiceUnavailableException({
        error: { code: 'NOT_CONFIGURED', message: 'PM Bridge plugin credentials are not configured' },
      });
    }
    return new SignJWT({ email })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.apiKey)
      .setAudience('pm-bridge-box')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.secret);
  }
}
