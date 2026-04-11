import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly frontendUrl: string;
  private readonly isDev: boolean;
  // WR-05: transport instantiated once in constructor and reused across all sends
  private readonly transport: nodemailer.Transporter | null;
  private readonly smtpFrom: string;

  constructor(private readonly configService: ConfigService) {
    this.frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:5173');
    this.isDev = this.configService.get<string>('NODE_ENV') !== 'production';
    this.smtpFrom = this.configService.get<string>('SMTP_FROM', 'noreply@talentos.triolla.io');

    const host = this.configService.get<string>('SMTP_HOST');
    this.transport = host
      ? nodemailer.createTransport({
          host,
          port: this.configService.get<number>('SMTP_PORT') ?? 587,
          auth: {
            user: this.configService.get<string>('SMTP_USER'),
            pass: this.configService.get<string>('SMTP_PASS'),
          },
        })
      : null;
  }

  private async sendOrLog(to: string, subject: string, text: string): Promise<void> {
    if (!this.transport) {
      // D-12: dev fallback — log instead of throw when SMTP_HOST absent
      this.logger.log({ to, subject, text }, '[EmailService DEV] Would send email:');
      return;
    }
    await this.transport.sendMail({
      from: this.smtpFrom,
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
