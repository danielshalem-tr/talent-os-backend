import { ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

// Mock ioredis before importing InvitationService
const mockRedis = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
};
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedis);
});

import { InvitationService } from './invitation.service';
import { AuthService } from './auth.service';
import { EmailService } from './email.service';
import { JwtService } from './jwt.service';
import { PrismaService } from '../prisma/prisma.service';

describe('InvitationService', () => {
  let service: InvitationService;
  let prisma: jest.Mocked<PrismaService>;
  let emailService: jest.Mocked<EmailService>;
  let authService: jest.Mocked<AuthService>;
  let jwtService: jest.Mocked<JwtService>;

  const mockOrg = {
    id: 'org-uuid-1',
    name: 'Triolla',
    logoUrl: null,
    shortId: 'triolla',
    isActive: true,
    createdByUserId: 'user-uuid-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    onboardingCompletedAt: null,
  };

  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const pastDate = new Date(Date.now() - 1000);

  const mockInvitation = {
    id: 'inv-uuid-1',
    organizationId: 'org-uuid-1',
    email: 'invitee@company.com',
    role: 'member',
    token: 'test-token-abc',
    status: 'pending',
    expiresAt: futureDate,
    invitedByUserId: 'user-uuid-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    organization: mockOrg,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findFirst: jest.fn(),
              create: jest.fn(),
            },
            invitation: {
              findUnique: jest.fn(),
              update: jest.fn(),
            },
            $transaction: jest.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: {
            signRefreshToken: jest.fn().mockResolvedValue('mock-session-token'),
          },
        },
        {
          provide: EmailService,
          useValue: {
            sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined),
            sendUseGoogleEmail: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: AuthService,
          useValue: {
            buildMeResponse: jest.fn().mockReturnValue({
              id: 'user-uuid-new',
              name: null,
              email: 'invitee@company.com',
              role: 'member',
              org_id: 'org-uuid-1',
              org_name: 'Triolla',
              org_logo_url: null,
              auth_provider: 'magic_link',
              has_completed_onboarding: false,
            }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379'),
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<InvitationService>(InvitationService);
    prisma = module.get(PrismaService);
    emailService = module.get(EmailService);
    authService = module.get(AuthService);
    jwtService = module.get(JwtService);
  });

  // ─── validateInvite ────────────────────────────────────────────────────────

  it('Test 1: validateInvite returns { org_name, role, email } for a pending non-expired invitation', async () => {
    (prisma.invitation.findUnique as jest.Mock).mockResolvedValue(mockInvitation);

    const result = await service.validateInvite('test-token-abc');

    expect(result).toEqual({
      org_name: 'Triolla',
      role: 'member',
      email: 'invitee@company.com',
    });
  });

  it('Test 2: validateInvite throws NotFoundException(NOT_FOUND) when token does not exist', async () => {
    (prisma.invitation.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(service.validateInvite('nonexistent-token')).rejects.toThrow(NotFoundException);
    await expect(service.validateInvite('nonexistent-token')).rejects.toMatchObject({
      response: { code: 'NOT_FOUND' },
    });
  });

  it('Test 3: validateInvite throws ConflictException(INVITE_USED) when invitation.status === accepted', async () => {
    const acceptedInvitation = { ...mockInvitation, status: 'accepted' };
    (prisma.invitation.findUnique as jest.Mock).mockResolvedValue(acceptedInvitation);

    await expect(service.validateInvite('test-token-abc')).rejects.toThrow(ConflictException);
    await expect(service.validateInvite('test-token-abc')).rejects.toMatchObject({
      response: { code: 'INVITE_USED' },
    });
  });

  it('Test 4: validateInvite throws GoneException(INVITE_EXPIRED) when invitation.expiresAt < now', async () => {
    const expiredInvitation = { ...mockInvitation, expiresAt: pastDate };
    (prisma.invitation.findUnique as jest.Mock).mockResolvedValue(expiredInvitation);

    await expect(service.validateInvite('test-token-abc')).rejects.toThrow(GoneException);
    await expect(service.validateInvite('test-token-abc')).rejects.toMatchObject({
      response: { code: 'INVITE_EXPIRED' },
    });
  });

  // ─── acceptInvite ──────────────────────────────────────────────────────────

  it('Test 5: acceptInvite creates user, marks invitation accepted, returns MeResponse + sessionToken', async () => {
    (prisma.invitation.findUnique as jest.Mock).mockResolvedValue(mockInvitation);
    const mockUser = {
      id: 'user-uuid-new',
      email: 'invitee@company.com',
      authProvider: 'magic_link',
      organizationId: 'org-uuid-1',
      role: 'member',
      fullName: null,
      isActive: true,
    };
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        user: { create: jest.fn().mockResolvedValue(mockUser) },
        invitation: { update: jest.fn().mockResolvedValue(undefined) },
      };
      return fn(tx);
    });

    const result = await service.acceptInvite('test-token-abc');

    expect(result).toHaveProperty('meResponse');
    expect(result).toHaveProperty('sessionToken', 'mock-session-token');
    expect(authService.buildMeResponse).toHaveBeenCalled();
    expect(jwtService.signRefreshToken).toHaveBeenCalledWith({
      sub: mockUser.id,
      org: mockUser.organizationId,
      role: mockUser.role,
    });
  });

  // ─── generateAndStoreMagicLink ─────────────────────────────────────────────

  it('Test 6: generateAndStoreMagicLink stores ml:{token} in Redis with TTL 3600 and sends email', async () => {
    const mockUser = {
      id: 'user-uuid-1',
      email: 'user@example.com',
      authProvider: 'magic_link',
    };
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(mockUser);
    mockRedis.set.mockResolvedValue('OK');

    await service.generateAndStoreMagicLink('user@example.com');

    // Should call redis.set with ml:{token}, userId, 'EX', 3600
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^ml:/),
      mockUser.id,
      'EX',
      3600,
    );
    expect(emailService.sendMagicLinkEmail).toHaveBeenCalledWith('user@example.com', expect.any(String));
  });

  // ─── verifyMagicLink ───────────────────────────────────────────────────────

  it('Test 7: verifyMagicLink returns null for unknown token (key not found in Redis)', async () => {
    mockRedis.get.mockResolvedValue(null);

    const result = await service.verifyMagicLink('unknown-token');

    expect(result).toBeNull();
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it('Test 8: verifyMagicLink deletes Redis key after successful lookup (one-time use)', async () => {
    mockRedis.get.mockResolvedValue('user-uuid-1');
    mockRedis.del.mockResolvedValue(1);

    const result = await service.verifyMagicLink('valid-token');

    expect(result).toEqual({ userId: 'user-uuid-1' });
    expect(mockRedis.del).toHaveBeenCalledWith('ml:valid-token');
  });
});
