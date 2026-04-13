import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService, MeResponse } from './auth.service';
import { JwtService, JwtPayload } from './jwt.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../storage/storage.service';

// ─── Mocks ─────────────────────────────────────────────────────────────────
const mockPrisma = {
  user: {
    findFirst: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  organization: {
    create: jest.fn(),
    update: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findUnique: jest.fn(),
  },
  $transaction: jest.fn(),
} as unknown as PrismaService;

const mockJwtService = {
  signRefreshToken: jest.fn().mockResolvedValue('mocked-session-token'),
} as unknown as JwtService;

const mockConfigService = {
  get: jest.fn(),
} as unknown as ConfigService;

const mockStorageService = {
  uploadLogoFromBuffer: jest.fn().mockResolvedValue(undefined),
} as unknown as StorageService;

// ─── Fixtures ──────────────────────────────────────────────────────────────
const mockOrg = {
  id: 'org-uuid',
  name: 'example.com',
  logoUrl: null,
  onboardingCompletedAt: null,
  shortId: 'examp-01',
  createdByUserId: 'user-uuid',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockUser = {
  id: 'user-uuid',
  email: 'test@example.com',
  fullName: 'Test User',
  role: 'owner',
  organizationId: 'org-uuid',
  authProvider: 'google',
  providerId: 'google-sub-123',
  avatarUrl: 'https://google.com/photo.jpg',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const expectedMeResponse: MeResponse = {
  id: 'user-uuid',
  name: 'Test User',
  email: 'test@example.com',
  role: 'owner',
  org_id: 'org-uuid',
  org_name: 'example.com',
  org_logo_url: null,
  auth_provider: 'google',
  has_completed_onboarding: false,
  avatar_url: 'https://google.com/photo.jpg',
};

// ─── Tests ─────────────────────────────────────────────────────────────────
describe('AuthService', () => {
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();

    // Default: no GOOGLE_CLIENT_ID → dev stub mode
    (mockConfigService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'GOOGLE_CLIENT_ID') return undefined;
      if (key === 'NODE_ENV') return 'development';
      return undefined;
    });

    service = new AuthService(mockPrisma, mockJwtService, mockConfigService, mockStorageService);
  });

  // Test 1: New email → create org + user, return MeResponse
  it('googleVerify with unknown email creates org, user, returns MeResponse', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);

    // $transaction mock: calls the callback with a tx object
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        organization: {
          create: jest.fn().mockResolvedValue(mockOrg),
          update: jest.fn().mockResolvedValue({ ...mockOrg, createdByUserId: 'user-uuid' }),
          findUnique: jest.fn().mockResolvedValue(null), // for shortId uniqueness check
        },
        user: {
          create: jest.fn().mockResolvedValue(mockUser),
        },
      };
      return fn(tx);
    });

    // Dev stub token: plain JSON { email, name }
    const accessToken = JSON.stringify({ email: 'test@example.com', name: 'Test User' });
    const result = await service.googleVerify(accessToken);

    expect(result.meResponse).toMatchObject(expectedMeResponse);
    expect(result.sessionToken).toBe('mocked-session-token');
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockJwtService.signRefreshToken).toHaveBeenCalledWith({
      sub: mockUser.id,
      org: mockOrg.id,
      role: 'owner',
    });
  });

  // Test 2: Existing email + auth_provider='google' → return session (existing user)
  it('googleVerify with existing google email returns session for existing user', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(mockUser);
    (mockPrisma.user.update as jest.Mock).mockResolvedValue(mockUser);
    (mockPrisma.organization.findUniqueOrThrow as jest.Mock).mockResolvedValue(mockOrg);

    const accessToken = JSON.stringify({ email: 'test@example.com', name: 'Test User' });
    const result = await service.googleVerify(accessToken);

    expect(result.meResponse).toMatchObject(expectedMeResponse);
    expect(result.sessionToken).toBe('mocked-session-token');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: mockUser.id },
      data: expect.objectContaining({
        authProvider: 'google',
      }),
    });
    expect(mockJwtService.signRefreshToken).toHaveBeenCalledWith({
      sub: mockUser.id,
      org: mockUser.organizationId,
      role: 'owner',
    });
  });

  it('googleVerify with existing email + magic_link authProvider auto-links to google', async () => {
    const magicLinkUser = { ...mockUser, authProvider: 'magic_link' };
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(magicLinkUser);
    (mockPrisma.user.update as jest.Mock).mockResolvedValue({ ...mockUser, authProvider: 'google' });
    (mockPrisma.organization.findUniqueOrThrow as jest.Mock).mockResolvedValue(mockOrg);

    const accessToken = JSON.stringify({ email: 'test@example.com', name: 'Test User' });
    const result = await service.googleVerify(accessToken);

    expect(result.meResponse).toMatchObject(expectedMeResponse);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: mockUser.id },
      data: expect.objectContaining({
        authProvider: 'google',
      }),
    });
  });

  // Test 4: getMe returns full MeResponse with has_completed_onboarding derived from onboardingCompletedAt
  it('getMe returns MeResponse with has_completed_onboarding=false when onboardingCompletedAt is null', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (mockPrisma.organization.findUnique as jest.Mock).mockResolvedValue(mockOrg);

    const session: JwtPayload = { sub: 'user-uuid', org: 'org-uuid', role: 'owner' };
    const result = await service.getMe(session);

    expect(result).toMatchObject(expectedMeResponse);
    expect(result.has_completed_onboarding).toBe(false);
  });

  it('getMe returns has_completed_onboarding=true when onboardingCompletedAt is set', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
    (mockPrisma.organization.findUnique as jest.Mock).mockResolvedValue({
      ...mockOrg,
      onboardingCompletedAt: new Date('2026-01-01'),
    });

    const session: JwtPayload = { sub: 'user-uuid', org: 'org-uuid', role: 'owner' };
    const result = await service.getMe(session);

    expect(result.has_completed_onboarding).toBe(true);
  });

  // Test 5: devParseToken parses plain JSON { email, name }
  it('devParseToken parses plain JSON access_token when GOOGLE_CLIENT_ID is absent', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);

    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        organization: {
          create: jest.fn().mockResolvedValue(mockOrg),
          update: jest.fn().mockResolvedValue(mockOrg),
          findUnique: jest.fn().mockResolvedValue(null),
        },
        user: {
          create: jest.fn().mockResolvedValue(mockUser),
        },
      };
      return fn(tx);
    });

    // Plain JSON (not base64) — dev stub
    const accessToken = JSON.stringify({ email: 'dev@stub.com', name: 'Dev User' });
    const result = await service.googleVerify(accessToken);

    expect(result.meResponse.email).toBe('test@example.com'); // from mockUser fixture
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({ where: { email: 'dev@stub.com' } });
  });

  // Test for UnauthorizedException on invalid dev stub token
  it('devParseToken throws UnauthorizedException for invalid token when GOOGLE_CLIENT_ID absent', async () => {
    const invalidToken = 'not-json-at-all!!!';
    await expect(service.googleVerify(invalidToken)).rejects.toThrow(UnauthorizedException);
  });
});
