import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly frontendUrl: string;
  private readonly isDev: boolean;
  // WR-05: Resend client instantiated once in constructor and reused across all sends
  private readonly resend: Resend | null;
  private readonly emailFrom: string;

  constructor(private readonly configService: ConfigService) {
    this.frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:5173');
    this.isDev = this.configService.get<string>('NODE_ENV') !== 'production';
    this.emailFrom = this.configService.get<string>('RESEND_FROM', 'noreply@talentos.triolla.io');

    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    this.resend = apiKey ? new Resend(apiKey) : null;
  }

  private async sendOrLog(to: string, subject: string, text: string): Promise<void> {
    if (!this.resend) {
      // D-12: dev fallback — log instead of throw when RESEND_API_KEY absent
      this.logger.log({ to, subject, text }, '[EmailService DEV] Would send email:');
      return;
    }
    await this.resend.emails.send({
      from: this.emailFrom,
      to,
      subject,
      text,
    });
  }

  async sendInvitationEmail(to: string, orgName: string, role: string, token: string): Promise<void> {
    const link = `${this.frontendUrl}/invite?token=${token}`;
    await this.sendOrLog(
      to,
      `You've been invited to join ${orgName} on Talent OS`,
      `You've been invited to join ${orgName} as ${role}.\n\nClick the link to accept: ${link}\n\nThis link expires in 7 days.`,
    );
  }

  async sendMagicLinkEmail(to: string, token: string): Promise<void> {
    const link = `${this.frontendUrl}/auth/magic-link/verify?token=${token}`;
    await this.sendOrLog(
      to,
      'Your Talent OS login link',
      `Click this link to log in to Talent OS:\n\n${link}\n\nThis link expires in 1 hour and can only be used once.`,
    );
  }

  async sendUseGoogleEmail(to: string): Promise<void> {
    await this.sendOrLog(
      to,
      'Log in with Google',
      `Your account uses Google Sign-In. Please click "Continue with Google" on the login page to access Talent OS.`,
    );
  }
}
