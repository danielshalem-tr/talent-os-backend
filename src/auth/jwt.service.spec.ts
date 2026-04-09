import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService, JwtPayload } from './jwt.service';

const TEST_SECRET = 'test-jwt-secret-for-unit-tests-minimum-32chars';

const mockPayload: JwtPayload = {
  sub: '00000000-0000-0000-0000-000000000001',
  org: '00000000-0000-0000-0000-000000000002',
  role: 'owner',
};

describe('JwtService', () => {
  let service: JwtService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) => {
              if (key === 'JWT_SECRET') return TEST_SECRET;
              throw new Error(`Unknown config key: ${key}`);
            },
          },
        },
      ],
    }).compile();

    service = module.get<JwtService>(JwtService);
  });

  it('sign() returns a non-empty JWT string', async () => {
    const token = await service.sign(mockPayload);
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3); // header.payload.signature
  });

  it('verify() decodes token and returns payload with sub, org, role fields', async () => {
    const token = await service.sign(mockPayload);
    const decoded = await service.verify(token);
    expect(decoded.sub).toBe(mockPayload.sub);
    expect(decoded.org).toBe(mockPayload.org);
    expect(decoded.role).toBe(mockPayload.role);
  });

  it('verify() throws UnauthorizedException on expired token', async () => {
    // Sign with -1s expiry (already expired) — jose does not accept '1ms' format
    const token = await service.sign(mockPayload, '-1s');
    await expect(service.verify(token)).rejects.toThrow(UnauthorizedException);
  });

  it('verify() throws UnauthorizedException on tampered token', async () => {
    const token = await service.sign(mockPayload);
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: 'hacker', org: 'evil', role: 'owner' })).toString('base64url');
    const tampered = parts.join('.');
    await expect(service.verify(tampered)).rejects.toThrow(UnauthorizedException);
  });

  it('signAccessToken() produces a token with ~15m expiry', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await service.signAccessToken(mockPayload);
    const decoded = await service.verify(token);
    const exp = (decoded as any).exp as number;
    // exp should be approximately 15 minutes from now (900 seconds)
    expect(exp).toBeGreaterThan(before + 890);
    expect(exp).toBeLessThan(before + 910);
  });

  it('signRefreshToken() produces a token with ~7d expiry', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await service.signRefreshToken(mockPayload);
    const decoded = await service.verify(token);
    const exp = (decoded as any).exp as number;
    // 7 days = 604800 seconds
    expect(exp).toBeGreaterThan(before + 604790);
    expect(exp).toBeLessThan(before + 604810);
  });
});
