import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService, JwtPayload } from './jwt.service';
import { EmailService } from './email.service';
import { AuthService, MeResponse } from './auth.service';

@Injectable()
export class InvitationService {
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly emailService: EmailService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {
    // Reuse BullMQ Redis connection (D-05 rationale: no separate Redis client needed)
    const redisUrl = this.configService.getOrThrow<string>('REDIS_URL');
    this.redis = new Redis(redisUrl, { lazyConnect: true });
  }

  /** D-05/D-06: Generate a magic link token, store in Redis, send email */
  async generateAndStoreMagicLink(email: string): Promise<void> {
    const user = await this.prisma.user.findFirst({ where: { email, isActive: true } });
    if (!user) return; // D-07: never reveal email existence — return silently

    if (user.authProvider === 'google') {
      // D-11: if Google-auth user tries magic link, send "use Google" email
      await this.emailService.sendUseGoogleEmail(email);
      return;
    }

    const token = randomBytes(32).toString('hex'); // D-06: cryptographically random
    const redisKey = `ml:${token}`;
    await this.redis.set(redisKey, user.id, 'EX', 3600); // D-06: TTL 3600s
    await this.emailService.sendMagicLinkEmail(email, token);
  }

  /**
   * D-07: Verify magic link token.
   * Returns { userId } on success, deletes key (one-time use).
   * Returns null if key not found (404 case).
   * NB: Redis TTL expiry makes key disappear → null = expired (410 case handled in controller).
   */
  async verifyMagicLink(token: string): Promise<{ userId: string } | null> {
    const redisKey = `ml:${token}`;
    const userId = await this.redis.get(redisKey);
    if (!userId) return null;
    await this.redis.del(redisKey); // D-07: one-time use
    return { userId };
  }

  /** Validate invitation token — returns details for confirmation page */
  async validateInvite(token: string): Promise<{ org_name: string; role: string; email: string }> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { token },
      include: { organization: true },
    });

    if (!invitation) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invitation not found' });
    }
    if (invitation.status === 'accepted') {
      throw new ConflictException({ code: 'INVITE_USED', message: 'This invitation has already been used' });
    }
    if (new Date() > invitation.expiresAt) {
      throw new GoneException({ code: 'INVITE_EXPIRED', message: 'This invitation has expired' });
    }

    return {
      org_name: invitation.organization.name,
      role: invitation.role,
      email: invitation.email,
    };
  }

  /** Accept invitation — creates user, marks accepted, issues session */
  async acceptInvite(token: string): Promise<{ meResponse: MeResponse; sessionToken: string }> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { token },
      include: { organization: true },
    });

    if (!invitation) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invitation not found' });
    }
    if (invitation.status === 'accepted') {
      throw new ConflictException({ code: 'INVITE_USED', message: 'This invitation has already been used' });
    }
    if (new Date() > invitation.expiresAt) {
      throw new GoneException({ code: 'INVITE_EXPIRED', message: 'This invitation has expired' });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: invitation.email,
          authProvider: 'magic_link',
          organizationId: invitation.organizationId,
          role: invitation.role,
          fullName: null,
          isActive: true,
        },
      });
      await tx.invitation.update({ where: { id: invitation.id }, data: { status: 'accepted' } });
      return { user, org: invitation.organization };
    });

    const sessionToken = await this.jwtService.signRefreshToken({
      sub: result.user.id,
      org: result.user.organizationId,
      role: result.user.role as JwtPayload['role'],
    });

    return {
      meResponse: this.authService.buildMeResponse(result.user, result.org),
      sessionToken,
    };
  }
}
