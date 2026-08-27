import { UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { ElevenLabsWebhookGuard } from './elevenlabs-webhook.guard';

// NOT mocked: the guard's value IS the SDK's real constructEvent verification —
// these tests sign real payloads and prove the real HMAC math end to end.

const SECRET = 'whsec_test_secret';

function sign(body: string, timestamp: number, secret = SECRET): string {
  const hex = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v0=${hex}`;
}

function makeContext(body: string, signatureHeader: string | undefined): ExecutionContext {
  const request = {
    headers: signatureHeader ? { 'elevenlabs-signature': signatureHeader } : {},
    rawBody: Buffer.from(body, 'utf8'),
  };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

// Two constructors: passing `undefined` to a defaulted parameter would silently restore
// the default, hiding the fail-closed case — so "no secret" gets its own factory.
function makeGuardWith(secret: string | undefined): ElevenLabsWebhookGuard {
  const config = { get: (key: string) => (key === 'ELEVENLABS_WEBHOOK_SECRET' ? secret : undefined) };
  return new ElevenLabsWebhookGuard(config as unknown as ConfigService);
}

function makeGuard(): ElevenLabsWebhookGuard {
  return makeGuardWith(SECRET);
}

describe('ElevenLabsWebhookGuard', () => {
  const body = '{"type":"post_call_transcription","data":{"conversation_id":"conv_1"}}';
  const now = Math.floor(Date.now() / 1000);

  it('accepts a valid signature', async () => {
    await expect(makeGuard().canActivate(makeContext(body, sign(body, now)))).resolves.toBe(true);
  });

  it('rejects when the secret env is unset (fail-closed)', async () => {
    await expect(makeGuardWith(undefined).canActivate(makeContext(body, sign(body, now)))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a missing or malformed header', async () => {
    await expect(makeGuard().canActivate(makeContext(body, undefined))).rejects.toThrow(UnauthorizedException);
    await expect(makeGuard().canActivate(makeContext(body, 'not-a-signature'))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a stale timestamp (> 30 minutes)', async () => {
    const stale = now - 31 * 60;
    await expect(makeGuard().canActivate(makeContext(body, sign(body, stale)))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    await expect(makeGuard().canActivate(makeContext(body, sign(body, now, 'wrong')))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a hex signature of the wrong length', async () => {
    await expect(makeGuard().canActivate(makeContext(body, `t=${now},v0=abcd`))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the body was tampered with after signing', async () => {
    const header = sign(body, now);
    await expect(makeGuard().canActivate(makeContext(body + ' ', header))).rejects.toThrow(UnauthorizedException);
  });
});
