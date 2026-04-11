import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import type { Request } from 'express';
import * as express from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { SessionGuard } from './session.guard';
import { AuthService } from './auth.service';
import { InvitationService } from './invitation.service';
import { JwtPayload } from './jwt.service';
import { JwtService } from './jwt.service';
import { PrismaService } from '../prisma/prisma.service';

const SESSION_COOKIE = 'talent_os_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days in ms (D-01)

function setSessionCookie(res: express.Response, token: string): void {
  // D-02: httpOnly, sameSite:lax, path:/, maxAge:7d, secure in production (T-19-07)
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
    secure: process.env.NODE_ENV === 'production',
  });
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly invitationService: InvitationService,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  // GET /auth/me — D-17: requires SessionGuard (T-19-08: unauthorized access mitigated)
  @Get('me')
  @UseGuards(SessionGuard)
  async getMe(@Req() req: Request) {
    const session = req.session as JwtPayload;
    return this.authService.getMe(session);
  }

  // POST /auth/google/verify — D-17: no SessionGuard (public endpoint)
  @Post('google/verify')
  @HttpCode(200)
  async googleVerify(
    @Body('access_token') accessToken: string,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    if (!accessToken) {
      return { error: { code: 'VALIDATION_ERROR', message: 'access_token is required', details: {} } };
    }
    const { meResponse, sessionToken } = await this.authService.googleVerify(accessToken);
    setSessionCookie(res, sessionToken);
    return meResponse;
  }

  // POST /auth/logout — D-04: clear cookie, returns { success: true }
  // D-17: SessionGuard NOT required — clearing cookie always succeeds regardless of session state
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: express.Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { success: true };
  }

  // POST /auth/onboarding — D-14: requires SessionGuard; multipart/form-data
  // T-19-15: ConflictException if onboardingCompletedAt already set
  @Post('onboarding')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('logo'))
  async completeOnboarding(
    @Req() req: Request,
    @Body('org_name') orgName: string,
    @UploadedFile() logo: Express.Multer.File | undefined,
  ) {
    if (!orgName || !orgName.trim()) {
      return { error: { code: 'VALIDATION_ERROR', message: 'org_name is required' } };
    }

    // WR-01: validate logo MIME type and size before uploading
    const ALLOWED_LOGO_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
    const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB
    if (logo) {
      if (!ALLOWED_LOGO_MIMES.includes(logo.mimetype)) {
        return { error: { code: 'INVALID_FILE_TYPE', message: 'Logo must be PNG, JPEG, WebP, or SVG' } };
      }
      if (logo.size > MAX_LOGO_BYTES) {
        return { error: { code: 'FILE_TOO_LARGE', message: 'Logo must be under 2 MB' } };
      }
    }

    return this.authService.completeOnboarding(req.session as JwtPayload, orgName.trim(), logo);
  }

  // POST /auth/magic-link — D-17: public (no guard); always returns 200 (T-19-11: no email enumeration)
  @Post('magic-link')
  @HttpCode(200)
  async requestMagicLink(@Body('email') email: string) {
    if (email) await this.invitationService.generateAndStoreMagicLink(email);
    return { success: true }; // always 200 — no email enumeration (T-19-11)
  }

  // GET /auth/magic-link/verify — D-07: validates token, sets session cookie, redirects to /
  // D-17: public endpoint (no guard)
  @Get('magic-link/verify')
  async verifyMagicLink(
    @Query('token') token: string,
    @Res() res: express.Response,
  ) {
    if (!token) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Token is required' } });
      return;
    }
    const result = await this.invitationService.verifyMagicLink(token);
    // WR-04: discriminated return — 'not_found' covers both TTL-expired and never-existed
    // (Redis gives no distinction; future improvement: shadow-key for expired vs invalid)
    if (result === 'not_found') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invalid or expired magic link' } });
      return;
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: user.organizationId } });
    const sessionToken = await this.jwtService.signRefreshToken({
      sub: user.id,
      org: user.organizationId,
      role: user.role as JwtPayload['role'],
    });
    setSessionCookie(res, sessionToken);
    res.redirect('/');
  }

  // GET /auth/invite/:token — D-17: public; returns invitation details for confirmation page
  @Get('invite/:token')
  async getInvite(@Param('token') token: string) {
    return this.invitationService.validateInvite(token);
  }

  // POST /auth/invite/:token/accept — D-17: public; creates user + sets session cookie
  @Post('invite/:token/accept')
  @HttpCode(200)
  async acceptInvite(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const { meResponse, sessionToken } = await this.invitationService.acceptInvite(token);
    setSessionCookie(res, sessionToken);
    return meResponse;
  }
}
