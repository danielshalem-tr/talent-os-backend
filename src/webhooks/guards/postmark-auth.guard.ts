import { CanActivate, ExecutionContext, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class PostmarkAuthGuard implements CanActivate {
  constructor(@Optional() private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    const authHeader = request.headers['authorization'];

    if (!authHeader) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    if (!authHeader.startsWith('Basic ')) {
      throw new UnauthorizedException('Invalid authorization scheme');
    }

    const base64Credentials = authHeader.slice(6);
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    // Postmark HTTP Basic Auth: username is ignored; only password (token) is validated
    const colonIndex = credentials.indexOf(':');
    const password = colonIndex >= 0 ? credentials.slice(colonIndex + 1) : credentials;

    const expected = this.configService.get<string>('POSTMARK_WEBHOOK_TOKEN') ?? '';

    const providedBuf = Buffer.from(password);
    const expectedBuf = Buffer.from(expected);

    if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      throw new UnauthorizedException('Invalid webhook credentials');
    }

    return true;
  }
}
