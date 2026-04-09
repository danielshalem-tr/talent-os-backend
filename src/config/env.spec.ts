import { envSchema } from './env';

const validEnv = {
  DATABASE_URL: 'postgresql://triolla:password@localhost:5432/triolla',
  REDIS_URL: 'redis://localhost:6379',
  // ANTHROPIC_API_KEY: 'sk-ant-test',
  OPENROUTER_API_KEY: 'sk-or-test',
  POSTMARK_WEBHOOK_TOKEN: 'test-token',
  TENANT_ID: '123e4567-e89b-12d3-a456-426614174000',
  R2_ACCOUNT_ID: 'acc123',
  R2_ACCESS_KEY_ID: 'key123',
  R2_SECRET_ACCESS_KEY: 'secret123',
  R2_BUCKET_NAME: 'triolla-cvs',
  NODE_ENV: 'test' as const,
  JWT_SECRET: 'test-jwt-secret-for-unit-tests-minimum-32chars',
};

describe('envSchema', () => {
  it('parses a valid environment object', () => {
    expect(() => envSchema.parse(validEnv)).not.toThrow();
  });

  it('throws when DATABASE_URL is missing', () => {
    const { DATABASE_URL, ...rest } = validEnv;
    expect(() => envSchema.parse(rest)).toThrow();
  });

  it('throws when DATABASE_URL is not a valid URL', () => {
    expect(() => envSchema.parse({ ...validEnv, DATABASE_URL: 'not-a-url' })).toThrow();
  });

  it('throws when TENANT_ID is not a valid UUID', () => {
    expect(() => envSchema.parse({ ...validEnv, TENANT_ID: 'not-a-uuid' })).toThrow();
  });

  // it('throws when ANTHROPIC_API_KEY is empty string', () => {
  //   expect(() => envSchema.parse({ ...validEnv, ANTHROPIC_API_KEY: '' })).toThrow();
  // });

  it('defaults NODE_ENV to production when omitted', () => {
    const { NODE_ENV, ...rest } = validEnv;
    const result = envSchema.parse(rest);
    expect(result.NODE_ENV).toBe('production');
  });
});
