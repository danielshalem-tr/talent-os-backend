import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from './email.service';
import { JwtPayload } from './jwt.service';

@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async getMembers(session: JwtPayload) {
    const users = await this.prisma.user.findMany({
      where: { organizationId: session.org, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      members: users.map((u) => ({
        id: u.id,
        name: u.fullName,
        email: u.email,
        role: u.role,
        joined_at: u.createdAt.toISOString(),
        auth_provider: u.authProvider,
      })),
    };
  }

  async getInvitations(session: JwtPayload) {
    const invitations = await this.prisma.invitation.findMany({
      where: {
        organizationId: session.org,
        status: 'pending',
        expiresAt: { gt: new Date() }, // non-expired only
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      invitations: invitations.map((inv) => ({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        expires_at: inv.expiresAt.toISOString(),
      })),
    };
  }

  async createInvitation(
    session: JwtPayload,
    email: string,
    role: string,
  ): Promise<{ id: string; email: string; role: string; expires_at: string }> {
    // Check ALREADY_MEMBER
    const existing = await this.prisma.user.findFirst({
      where: { organizationId: session.org, email, isActive: true },
    });
    if (existing) {
      throw new ConflictException({
        code: 'ALREADY_MEMBER',
        message: 'This user is already a member of the organization',
      });
    }

    // Check PENDING_INVITATION
    const pendingInvite = await this.prisma.invitation.findFirst({
      where: {
        organizationId: session.org,
        email,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
    });
    if (pendingInvite) {
      throw new ConflictException({
        code: 'PENDING_INVITATION',
        message: 'A pending invitation has already been sent to this email',
      });
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: session.org } });

    const invitation = await this.prisma.invitation.create({
      data: {
        organizationId: session.org,
        email,
        role,
        token,
        status: 'pending',
        expiresAt,
        invitedByUserId: session.sub,
      },
    });

    // Send email (non-blocking error — log failure but don't fail the request)
    try {
      await this.emailService.sendInvitationEmail(email, org.name, role, token);
    } catch (err) {
      // Log but don't fail — invitation record is already created
      console.error('[TeamService] Failed to send invitation email:', err);
    }

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expires_at: invitation.expiresAt.toISOString(),
    };
  }

  async cancelInvitation(session: JwtPayload, invitationId: string): Promise<void> {
    const invitation = await this.prisma.invitation.findFirst({
      where: { id: invitationId, organizationId: session.org },
    });
    if (!invitation) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invitation not found' });
    }
    await this.prisma.invitation.delete({ where: { id: invitationId } });
  }

  async changeRole(
    session: JwtPayload,
    targetUserId: string,
    newRole: string,
  ): Promise<{ success: true }> {
    // D-18: inline role enforcement — Owner only
    if (session.role !== 'owner') {
      throw new ForbiddenException('Only the Owner can change member roles');
    }
    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, organizationId: session.org, isActive: true },
    });
    if (!target) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Member not found' });
    }
    if (target.role === 'owner') {
      throw new ForbiddenException('Cannot change the role of the Owner');
    }
    await this.prisma.user.update({ where: { id: targetUserId }, data: { role: newRole } });
    return { success: true };
  }

  async removeMember(session: JwtPayload, targetUserId: string): Promise<void> {
    // D-18: inline role enforcement
    if (session.role !== 'owner') {
      throw new ForbiddenException('Only the Owner can remove members');
    }
    if (targetUserId === session.sub) {
      throw new ForbiddenException('Cannot remove yourself');
    }
    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, organizationId: session.org, isActive: true },
    });
    if (!target) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Member not found' });
    }
    if (target.role === 'owner') {
      throw new ForbiddenException('Cannot remove another Owner');
    }
    // Soft delete: immediately revokes access on next request
    await this.prisma.user.update({ where: { id: targetUserId }, data: { isActive: false } });
  }
}
