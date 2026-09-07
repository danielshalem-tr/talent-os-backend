import { apiEnvSchema, envSchema } from './env';

const validEnv = {
  DATABASE_URL: 'postgresql://triolla:password@localhost:5432/triolla',
  REDIS_URL: 'redis://localhost:6379',
  // ANTHROPIC_API_KEY: 'sk-ant-test',
  OPENROUTER_API_KEY: 'sk-or-test',
  MAILGUN_WEBHOOK_SIGNING_KEY: 'test-signing-key',
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

  // PM Bridge moved to the standalone Box (2026-09 cutover). Neither process needs Jira
  // any more, and stale JIRA_*/PM_* keys still present in a deploy env must be ignored,
  // not validated — zod's default object mode strips unknown keys.
  it('api schema (apiEnvSchema) parses a valid environment object', () => {
    expect(() => apiEnvSchema.parse(validEnv)).not.toThrow();
  });

  it('api and worker schemas boot without any Jira / PM Bridge variables and drop stale ones', () => {
    const stale = {
      ...validEnv,
      JIRA_BASE_URL: 'https://example.atlassian.net',
      JIRA_API_TOKEN: 'leftover',
      PM_BRIDGE_ALLOWLIST: 'a@b.c',
      PM_HOLD_TOKEN_SECRET: 'short',
    };
    const api = apiEnvSchema.parse(stale);
    const worker = envSchema.parse(stale);
    for (const parsed of [api, worker]) {
      expect(parsed).not.toHaveProperty('JIRA_BASE_URL');
      expect(parsed).not.toHaveProperty('JIRA_API_TOKEN');
      expect(parsed).not.toHaveProperty('PM_BRIDGE_ALLOWLIST');
      expect(parsed).not.toHaveProperty('PM_HOLD_TOKEN_SECRET');
    }
  });

  // Voice screening env — deploys ship BEFORE ElevenLabs setup, so nothing here may be
  // required at boot; and a typo'd mode must never mean "live".
  it('boots (worker and api schemas) without any ElevenLabs configuration', () => {
    expect(() => envSchema.parse(validEnv)).not.toThrow();
    expect(() => apiEnvSchema.parse(validEnv)).not.toThrow();
  });

  it('defaults VOICE_CALL_MODE to test', () => {
    const parsed = envSchema.parse(validEnv);
    expect(parsed.VOICE_CALL_MODE).toBe('test');
  });

  it('rejects an invalid VOICE_CALL_MODE (typo can never mean live)', () => {
    expect(() => envSchema.parse({ ...validEnv, VOICE_CALL_MODE: 'prod' })).toThrow();
  });

  it('accepts VOICE_CALL_MODE=live and defaults VOICE_CALL_ALLOWLIST to empty', () => {
    const parsed = envSchema.parse({ ...validEnv, VOICE_CALL_MODE: 'live' });
    expect(parsed.VOICE_CALL_MODE).toBe('live');
    expect(parsed.VOICE_CALL_ALLOWLIST).toBe('');
  });

  it('defaults ELEVENLABS_TELEPHONY to sip (the Scheduler-proven number is a SIP-trunk import) and rejects unknown values', () => {
    expect(envSchema.parse(validEnv).ELEVENLABS_TELEPHONY).toBe('sip');
    expect(envSchema.parse({ ...validEnv, ELEVENLABS_TELEPHONY: 'twilio' }).ELEVENLABS_TELEPHONY).toBe('twilio');
    expect(() => envSchema.parse({ ...validEnv, ELEVENLABS_TELEPHONY: 'pstn' })).toThrow();
  });
});

describe('AUTH_ALLOWED_DOMAINS / TENANT_ID pairing', () => {
  it('api schema throws at boot when AUTH_ALLOWED_DOMAINS is set without TENANT_ID', () => {
    const { TENANT_ID, ...noTenant } = validEnv;
    expect(() => apiEnvSchema.parse({ ...noTenant, AUTH_ALLOWED_DOMAINS: 'triolla.io' })).toThrow();
  });

  it('api schema accepts AUTH_ALLOWED_DOMAINS with TENANT_ID, and unset with or without TENANT_ID', () => {
    expect(() => apiEnvSchema.parse({ ...validEnv, AUTH_ALLOWED_DOMAINS: 'triolla.io' })).not.toThrow();
    const { TENANT_ID, ...noTenant } = validEnv;
    expect(() => apiEnvSchema.parse(noTenant)).not.toThrow();
  });

  it('worker base schema does not enforce the pairing (it never runs googleVerify)', () => {
    const { TENANT_ID, ...noTenant } = validEnv;
    expect(() => envSchema.parse({ ...noTenant, AUTH_ALLOWED_DOMAINS: 'triolla.io' })).not.toThrow();
  });
});

describe('PMB (standalone pm-bridge plugin) vars', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    OPENROUTER_API_KEY: 'k',
    MAILGUN_WEBHOOK_SIGNING_KEY: 'k',
    R2_ACCOUNT_ID: 'a',
    R2_ACCESS_KEY_ID: 'a',
    R2_SECRET_ACCESS_KEY: 'a',
    R2_BUCKET_NAME: 'b',
    JWT_SECRET: 'x'.repeat(32),
  };

  it('parses without PMB vars (plugin unconfigured)', () => {
    const result = envSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PMB_API_KEY).toBeUndefined();
      expect(result.data.PMB_SIGNING_SECRET).toBeUndefined();
    }
  });

  it('accepts valid PMB vars', () => {
    const result = envSchema.safeParse({
      ...base,
      PMB_API_KEY: 'pmb_abc123',
      PMB_SIGNING_SECRET: 's'.repeat(64),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a short PMB_SIGNING_SECRET', () => {
    const result = envSchema.safeParse({ ...base, PMB_SIGNING_SECRET: 'short' });
    expect(result.success).toBe(false);
  });
});
