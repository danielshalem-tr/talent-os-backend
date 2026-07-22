import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jwtVerify } from 'jose';
import { PmbTokenService } from './pmb-token.service';

const SECRET = 'f'.repeat(64);
const API_KEY = 'pmb_test_key';

function makeService(env: Record<string, string | undefined>): PmbTokenService {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return new PmbTokenService(config);
}

describe('PmbTokenService', () => {
  it('mints a vouch JWT with the pinned claims', async () => {
    const service = makeService({ PMB_API_KEY: API_KEY, PMB_SIGNING_SECRET: SECRET });
    const token = await service.mint('pm@triolla.io');

    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      issuer: API_KEY,
      audience: 'pm-bridge-box',
    });
    expect(payload.email).toBe('pm@triolla.io');
    expect(payload.iat).toBeDefined();
    // exp − iat = 5 minutes
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);
  });

  it('throws 503 when PMB vars are missing', async () => {
    const service = makeService({});
    await expect(service.mint('pm@triolla.io')).rejects.toThrow(ServiceUnavailableException);
  });
});
