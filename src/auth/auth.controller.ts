import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import type { Request } from 'express';
import * as express from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { SessionGuard } from './session.guard';
import { AuthService } from './auth.service';
import { InvitationService } from './invitation.service';
import { JwtPayload } from './jwt.service';
import { Public } from '../common/decorators/public.decorator';

const SESSION_COOKIE = 'talent_os_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days in ms (D-01)

function setSessionCookie(res: express.Response, token: string): void {
  // D-02: httpOnly, sameSite:lax, path:/, maxAge:7d, secure in production (T-19-07)
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
    // Not NODE_ENV alone: a deploy that leaks NODE_ENV=development must not ship a
    // non-Secure cookie over an HTTPS frontend.
    secure: process.env.NODE_ENV === 'production' || (process.env.FRONTEND_URL ?? '').startsWith('https://'),
  });
}

// Rate-limited controller-wide (app default 100/min/IP) — pre-auth endpoints are the
// brute-force / outbound-email abuse surface; stricter per-route overrides below.
@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly invitationService: InvitationService,
  ) {}

  // GET /auth/me — D-17: requires SessionGuard (T-19-08: unauthorized access mitigated)
  @Get('me')
  @UseGuards(SessionGuard)
  async getMe(@Req() req: Request) {
    const session = req.session as JwtPayload;
    return this.authService.getMe(session);
  }

  // POST /auth/google/verify — D-17: no SessionGuard (public endpoint)
  @Public()
  @Post('google/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async googleVerify(@Body('access_token') accessToken: string, @Res({ passthrough: true }) res: express.Response) {
    if (!accessToken) {
      return { error: { code: 'VALIDATION_ERROR', message: 'access_token is required', details: {} } };
    }
    const { meResponse, sessionToken } = await this.authService.googleVerify(accessToken);
    setSessionCookie(res, sessionToken);
    return meResponse;
  }

  // POST /auth/logout — D-04: clear cookie, returns { success: true }
  // D-17: SessionGuard NOT required — clearing cookie always succeeds regardless of session state
  @Public()
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: express.Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { success: true };
  }

  // POST /auth/onboarding — D-14: requires SessionGuard; multipart/form-data
  // T-19-15: ConflictException if onboardingCompletedAt already set.
  // Input validation (org_name, logo MIME/size) lives in AuthService — handlers stay logic-free.
  @Post('onboarding')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('logo'))
  async completeOnboarding(
    @Req() req: Request,
    @Body('org_name') orgName: string,
    @UploadedFile() logo: Express.Multer.File | undefined,
  ) {
    return this.authService.completeOnboarding(req.session as JwtPayload, orgName, logo);
  }

  // POST /auth/magic-link — D-17: public (no guard); always returns 200 (T-19-11: no email enumeration)
  @Public()
  @Post('magic-link')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 emails/min/IP — unbounded outbound email otherwise
  async requestMagicLink(@Body('email') email: string) {
    if (email) await this.invitationService.generateAndStoreMagicLink(email);
    return { success: true }; // always 200 — no email enumeration (T-19-11)
  }

  // POST /auth/magic-link/verify — D-07: validates token, sets session cookie, returns JSON success
  // D-17: public endpoint (no guard). Token verification + session creation live in InvitationService.
  @Public()
  @Post('magic-link/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // brute-force brake on token guessing
  async verifyMagicLink(@Body('token') token: string, @Res({ passthrough: true }) res: express.Response) {
    const result = await this.invitationService.verifyMagicLinkSession(token);
    if (!result.ok) {
      res.status(result.status).json({ error: { code: result.code, message: result.message } });
      return;
    }
    setSessionCookie(res, result.sessionToken);
    return { success: true };
  }

  // GET /auth/invite/:token — D-17: public; returns invitation details for confirmation page
  @Public()
  @Get('invite/:token')
  async getInvite(@Param('token') token: string) {
    return this.invitationService.validateInvite(token);
  }

  // POST /auth/invite/:token/accept — D-17: public; creates user + sets session cookie
  @Public()
  @Post('invite/:token/accept')
  @HttpCode(200)
  async acceptInvite(@Param('token') token: string, @Res({ passthrough: true }) res: express.Response) {
    const { meResponse, sessionToken } = await this.invitationService.acceptInvite(token);
    setSessionCookie(res, sessionToken);
    return meResponse;
  }
}
