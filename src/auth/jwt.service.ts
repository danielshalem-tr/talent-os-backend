import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, jwtVerify } from 'jose';

export interface JwtPayload {
  sub: string; // user UUID (D-17: use sub, NOT userId)
  org: string; // organization UUID (D-17: use org, NOT organizationId)
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

@Injectable()
export class JwtService {
  private readonly secret: Uint8Array;

  constructor(private readonly configService: ConfigService) {
    // configService.getOrThrow() fails fast if JWT_SECRET is missing (D-19)
    const raw = this.configService.getOrThrow<string>('JWT_SECRET');
    // jose requires Uint8Array — NOT a plain string (D-16 / Error 11)
    this.secret = new TextEncoder().encode(raw);
  }

  async sign(payload: JwtPayload, expiresIn = '15m'): Promise<string> {
    return new SignJWT(payload as Record<string, unknown>)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(this.secret);
  }

  async verify(token: string): Promise<JwtPayload> {
    try {
      const { payload } = await jwtVerify(token, this.secret);
      return payload as unknown as JwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  signAccessToken(payload: JwtPayload): Promise<string> {
    return this.sign(payload, '15m');
  }

  signRefreshToken(payload: JwtPayload): Promise<string> {
    return this.sign(payload, '7d');
  }
}
