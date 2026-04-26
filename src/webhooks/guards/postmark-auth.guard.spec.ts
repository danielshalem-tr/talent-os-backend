import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostmarkAuthGuard } from './postmark-auth.guard';

describe('PostmarkAuthGuard', () => {
  let guard: PostmarkAuthGuard;
  let mockConfigService: Partial<ConfigService>;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn().mockReturnValue('test-token'),
    };
    guard = new PostmarkAuthGuard(mockConfigService as ConfigService);
  });

  function buildContext(authHeader?: string) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: authHeader ? { authorization: authHeader } : {},
        }),
      }),
    } as any;
  }

  it('rejects request with missing Authorization header → throws UnauthorizedException', () => {
    const ctx = buildContext();
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects request with wrong password in Basic Auth → throws UnauthorizedException', () => {
    const wrongCreds = Buffer.from('user:wrong-token').toString('base64');
    const ctx = buildContext(`Basic ${wrongCreds}`);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('accepts request with correct Basic Auth credentials → returns true', () => {
    const correctCreds = Buffer.from('postmark:test-token').toString('base64');
    const ctx = buildContext(`Basic ${correctCreds}`);
    const result = guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('rejects token with correct prefix followed by extra characters — truncation attack blocked', () => {
    const malicious = Buffer.from('user:test-tokenEXTRA_JUNK').toString('base64');
    const ctx = buildContext(`Basic ${malicious}`);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
