import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService, JwtPayload } from './jwt.service';
import { StorageService } from '../storage/storage.service';
import { generateOrgShortId } from './utils/generate-short-id';

export interface MeResponse {
  id: string;
  name: string | null;
  email: string;
  role: string;
  org_id: string;
  org_name: string;
  org_logo_url: string | null;
  auth_provider: string;
  has_completed_onboarding: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly storageService: StorageService,
  ) {}

  /**
   * D-19/D-20: Fetch user info from Google or dev-stub.
   * If GOOGLE_CLIENT_ID is absent (or NODE_ENV !== 'production'), parse access_token as JSON.
   */
  private async fetchGoogleUserInfo(
    accessToken: string,
  ): Promise<{ email: string; name: string; sub?: string }> {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const isProd = this.configService.get<string>('NODE_ENV') === 'production';

    if (!clientId || !isProd) {
      // D-20: dev stub — parse access_token as JSON { email, name }
      // Try base64 first, then plain JSON
      try {
        const decoded = Buffer.from(accessToken, 'base64').toString('utf-8');
        return JSON.parse(decoded) as { email: string; name: string };
      } catch {
        try {
          return JSON.parse(accessToken) as { email: string; name: string };
        } catch {
          throw new UnauthorizedException('Invalid dev stub token (expected JSON { email, name })');
        }
      }
    }

    // Production: call Google UserInfo API (T-19-06: backend re-validates token)
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new UnauthorizedException('Google token verification failed');
    return res.json() as Promise<{ email: string; name: string; sub: string }>;
  }

  /**
   * D-21/D-22/D-23: Google sign-up or sign-in flow.
   */
  async googleVerify(
    accessToken: string,
  ): Promise<{ meResponse: MeResponse; sessionToken: string }> {
    const googleUser = await this.fetchGoogleUserInfo(accessToken);
    const email = googleUser.email;

    // D-22: Check if user already exists globally by email
    const existingUser = await this.prisma.user.findFirst({ where: { email } });

    if (existingUser) {
      if (existingUser.authProvider !== 'google') {
        // T-19-09: reject if email registered with different auth method
        throw new ConflictException({
          code: 'EMAIL_EXISTS',
          message: 'This email is registered with a different login method.',
        });
      }
      const org = await this.prisma.organization.findUniqueOrThrow({
        where: { id: existingUser.organizationId },
      });
      const sessionToken = await this.jwtService.signRefreshToken({
        sub: existingUser.id,
        org: existingUser.organizationId,
        role: existingUser.role as JwtPayload['role'],
      });
      return { meResponse: this.buildMeResponse(existingUser, org), sessionToken };
    }

    // D-21: new user — create org + user in single DB transaction (D-24 from Phase 18)
    const orgName = email.split('@')[1] ?? email; // D-23: use email domain as org default name
    const result = await this.prisma.$transaction(async (tx) => {
      // Step 1: create org with createdByUserId = null (chicken-and-egg sequence D-24)
      const org = await tx.organization.create({
        data: {
          name: orgName,
          shortId: await generateOrgShortId(orgName, this.prisma),
        },
      });
      // Step 2: create user with role='owner'
      const user = await tx.user.create({
        data: {
          email,
          fullName: googleUser.name ?? null,
          authProvider: 'google',
          organizationId: org.id,
          role: 'owner',
          providerId: googleUser.sub ?? null,
        },
      });
      // Step 3: update org with createdByUserId = user.id
      await tx.organization.update({ where: { id: org.id }, data: { createdByUserId: user.id } });
      return { org: { ...org, createdByUserId: user.id }, user };
    });

    const sessionToken = await this.jwtService.signRefreshToken({
      sub: result.user.id,
      org: result.org.id,
      role: 'owner',
    });
    return { meResponse: this.buildMeResponse(result.user, result.org), sessionToken };
  }

  /**
   * D-15: Build GET /auth/me response from user + org records.
   */
  async getMe(session: JwtPayload): Promise<MeResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: session.sub } });
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: session.org } });
    return this.buildMeResponse(user, org);
  }

  buildMeResponse(
    user: {
      id: string;
      fullName: string | null;
      email: string;
      role: string;
      organizationId: string;
      authProvider: string;
    },
    org: {
      id: string;
      name: string;
      logoUrl: string | null;
      onboardingCompletedAt?: Date | null;
    },
  ): MeResponse {
    return {
      id: user.id,
      name: user.fullName,
      email: user.email,
      role: user.role,
      org_id: org.id,
      org_name: org.name,
      org_logo_url: org.logoUrl ?? null,
      auth_provider: user.authProvider,
      has_completed_onboarding: org.onboardingCompletedAt != null,
    };
  }

  /**
   * D-14: Complete onboarding — sets org name + onboardingCompletedAt.
   * Throws 409 Conflict if onboarding already completed (T-19-15: double-submit protection).
   */
  async completeOnboarding(
    session: JwtPayload,
    orgName: string,
    logoFile?: Express.Multer.File,
  ): Promise<{ success: true }> {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: session.org } });
    if (org.onboardingCompletedAt != null) {
      throw new ConflictException({ code: 'ONBOARDING_COMPLETE', message: 'Onboarding already completed' });
    }

    let logoUrl: string | undefined;
    if (logoFile) {
      // Upload logo to R2 — key: logos/{orgId}/{timestamp}.{ext}
      const ext = logoFile.originalname.split('.').pop() ?? 'png';
      const key = `logos/${session.org}/${Date.now()}.${ext}`;
      await this.storageService.uploadLogoFromBuffer(logoFile.buffer, logoFile.mimetype, key);
      logoUrl = key;
    }

    await this.prisma.organization.update({
      where: { id: session.org },
      data: {
        name: orgName,
        onboardingCompletedAt: new Date(),
        ...(logoUrl !== undefined ? { logoUrl } : {}),
      },
    });
    return { success: true };
  }
}
