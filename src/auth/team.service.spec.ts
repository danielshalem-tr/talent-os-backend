import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TeamService } from './team.service';
import { EmailService } from './email.service';
import { JwtPayload } from './jwt.service';
import { PrismaService } from '../prisma/prisma.service';

describe('TeamService', () => {
  let service: TeamService;
  let prisma: jest.Mocked<PrismaService>;
  let emailService: jest.Mocked<EmailService>;

  const ownerSession: JwtPayload = {
    sub: 'owner-uuid',
    org: 'org-uuid-1',
    role: 'owner',
  };

  const memberSession: JwtPayload = {
    sub: 'member-uuid',
    org: 'org-uuid-1',
    role: 'member',
  };

  const mockOrg = {
    id: 'org-uuid-1',
    name: 'Triolla',
  };

  const mockUsers = [
    {
      id: 'owner-uuid',
      email: 'owner@company.com',
      fullName: 'Alice Owner',
      role: 'owner',
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      authProvider: 'google',
    },
    {
      id: 'member-uuid',
      email: 'member@company.com',
      fullName: 'Bob Member',
      role: 'member',
      isActive: true,
      createdAt: new Date('2026-01-15T00:00:00Z'),
      authProvider: 'magic_link',
    },
  ];

  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const mockPendingInvitation = {
    id: 'inv-uuid-1',
    email: 'newbie@company.com',
    role: 'admin',
    status: 'pending',
    expiresAt: futureDate,
    organizationId: 'org-uuid-1',
    createdAt: new Date('2026-04-01T00:00:00Z'),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findMany: jest.fn(),
              findFirst: jest.fn(),
              update: jest.fn(),
            },
            invitation: {
              findMany: jest.fn(),
              findFirst: jest.fn(),
              create: jest.fn(),
              delete: jest.fn(),
            },
            organization: {
              findUniqueOrThrow: jest.fn(),
            },
          },
        },
        {
          provide: EmailService,
          useValue: {
            sendInvitationEmail: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<TeamService>(TeamService);
    prisma = module.get(PrismaService);
    emailService = module.get(EmailService);
  });

  // ─── getMembers ────────────────────────────────────────────────────────────

  it('Test 1: getMembers returns array of { id, name, email, role, joined_at, auth_provider } for active users in org', async () => {
    (prisma.user.findMany as jest.Mock).mockResolvedValue(mockUsers);

    const result = await service.getMembers(ownerSession);

    expect(result).toEqual({
      members: [
        {
          id: 'owner-uuid',
          name: 'Alice Owner',
          email: 'owner@company.com',
          role: 'owner',
          joined_at: '2026-01-01T00:00:00.000Z',
          auth_provider: 'google',
        },
        {
          id: 'member-uuid',
          name: 'Bob Member',
          email: 'member@company.com',
          role: 'member',
          joined_at: '2026-01-15T00:00:00.000Z',
          auth_provider: 'magic_link',
        },
      ],
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-uuid-1', isActive: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  // ─── getInvitations ────────────────────────────────────────────────────────

  it('Test 2: getInvitations returns pending non-expired invitations for org', async () => {
    (prisma.invitation.findMany as jest.Mock).mockResolvedValue([mockPendingInvitation]);

    const result = await service.getInvitations(ownerSession);

    expect(result.invitations).toHaveLength(1);
    expect(result.invitations[0]).toMatchObject({
      id: 'inv-uuid-1',
      email: 'newbie@company.com',
      role: 'admin',
    });
    expect(result.invitations[0]).toHaveProperty('expires_at');
    // Verify the query filters by org, pending status, and non-expired
    expect(prisma.invitation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-uuid-1',
          status: 'pending',
        }),
      }),
    );
  });

  // ─── createInvitation ──────────────────────────────────────────────────────

  it('Test 3: createInvitation returns 409 ALREADY_MEMBER when email is an active user in the org', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(mockUsers[1]); // email already a member

    await expect(service.createInvitation(ownerSession, 'member@company.com', 'admin')).rejects.toThrow(
      ConflictException,
    );
    await expect(
      service.createInvitation(ownerSession, 'member@company.com', 'admin'),
    ).rejects.toMatchObject({
      response: { code: 'ALREADY_MEMBER' },
    });
  });

  it('Test 4: createInvitation returns 409 PENDING_INVITATION when pending invite already exists for email', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null); // not a member
    (prisma.invitation.findFirst as jest.Mock).mockResolvedValue(mockPendingInvitation); // but has pending invite

    await expect(service.createInvitation(ownerSession, 'newbie@company.com', 'admin')).rejects.toThrow(
      ConflictException,
    );
    await expect(
      service.createInvitation(ownerSession, 'newbie@company.com', 'admin'),
    ).rejects.toMatchObject({
      response: { code: 'PENDING_INVITATION' },
    });
  });

  it('Test 5: createInvitation creates invitation, calls sendInvitationEmail, returns { id, email, role, expires_at }', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.invitation.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.organization.findUniqueOrThrow as jest.Mock).mockResolvedValue(mockOrg);
    const createdInvitation = {
      id: 'inv-uuid-new',
      email: 'newcolleague@company.com',
      role: 'admin',
      expiresAt: futureDate,
    };
    (prisma.invitation.create as jest.Mock).mockResolvedValue(createdInvitation);

    const result = await service.createInvitation(ownerSession, 'newcolleague@company.com', 'admin');

    expect(result).toEqual({
      id: 'inv-uuid-new',
      email: 'newcolleague@company.com',
      role: 'admin',
      expires_at: futureDate.toISOString(),
    });
    expect(emailService.sendInvitationEmail).toHaveBeenCalledWith(
      'newcolleague@company.com',
      'Triolla',
      'admin',
      expect.any(String),
    );
    // Verify 7-day expiry is set
    const createCall = (prisma.invitation.create as jest.Mock).mock.calls[0][0];
    const expiresAt: Date = createCall.data.expiresAt;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + sevenDaysMs - 5000);
    expect(expiresAt.getTime()).toBeLessThan(Date.now() + sevenDaysMs + 5000);
  });

  // ─── changeRole ────────────────────────────────────────────────────────────

  it('Test 6: changeRole throws ForbiddenException when caller role !== owner', async () => {
    await expect(service.changeRole(memberSession, 'another-user-uuid', 'admin')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('Test 7: changeRole throws ForbiddenException when target user role === owner', async () => {
    const targetOwner = { ...mockUsers[0], id: 'other-owner-uuid', role: 'owner' };
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(targetOwner);

    await expect(service.changeRole(ownerSession, 'other-owner-uuid', 'admin')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('Test 8: changeRole updates user.role and returns { success: true }', async () => {
    const targetMember = { ...mockUsers[1], id: 'member-uuid', role: 'member' };
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(targetMember);
    (prisma.user.update as jest.Mock).mockResolvedValue({ ...targetMember, role: 'admin' });

    const result = await service.changeRole(ownerSession, 'member-uuid', 'admin');

    expect(result).toEqual({ success: true });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'member-uuid' },
      data: { role: 'admin' },
    });
  });

  // ─── removeMember ──────────────────────────────────────────────────────────

  it('Test 9: removeMember throws ForbiddenException when caller is not owner', async () => {
    await expect(service.removeMember(memberSession, 'another-uuid')).rejects.toThrow(ForbiddenException);
  });

  it('Test 10: removeMember throws ForbiddenException when caller targets themselves', async () => {
    await expect(service.removeMember(ownerSession, 'owner-uuid')).rejects.toThrow(ForbiddenException);
  });

  it('Test 11: removeMember sets user.isActive = false (soft delete)', async () => {
    const targetMember = { ...mockUsers[1], id: 'member-uuid', role: 'member' };
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(targetMember);
    (prisma.user.update as jest.Mock).mockResolvedValue({ ...targetMember, isActive: false });

    await service.removeMember(ownerSession, 'member-uuid');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'member-uuid' },
      data: { isActive: false },
    });
  });
});
