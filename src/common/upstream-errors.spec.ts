import { AI_CALL_TIMEOUT_MS, aiCallGuards, isRetryableUpstreamError } from './upstream-errors';

const apiError = (statusCode: number, isRetryable = false) =>
  Object.assign(new Error(`HTTP ${statusCode}`), { name: 'AI_APICallError', statusCode, isRetryable });

describe('isRetryableUpstreamError', () => {
  it('treats provider outages as retryable: 402 credits, 429, 5xx, SDK isRetryable', () => {
    expect(isRetryableUpstreamError(apiError(402))).toBe(true);
    expect(isRetryableUpstreamError(apiError(429))).toBe(true);
    expect(isRetryableUpstreamError(apiError(503))).toBe(true);
    expect(isRetryableUpstreamError(apiError(408, true))).toBe(true);
  });

  it('treats bad requests and auth failures as permanent', () => {
    expect(isRetryableUpstreamError(apiError(400))).toBe(false);
    expect(isRetryableUpstreamError(apiError(401))).toBe(false);
    expect(isRetryableUpstreamError(new Error('null character not permitted'))).toBe(false);
  });

  it('unwraps AI_RetryError to its lastError', () => {
    const wrapped = Object.assign(new Error('gave up'), { name: 'AI_RetryError', lastError: apiError(502) });
    expect(isRetryableUpstreamError(wrapped)).toBe(true);
    const wrappedPermanent = Object.assign(new Error('gave up'), { name: 'AI_RetryError', lastError: apiError(400) });
    expect(isRetryableUpstreamError(wrappedPermanent)).toBe(false);
  });

  it('treats timeouts and socket errors as retryable', () => {
    expect(isRetryableUpstreamError(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))).toBe(true);
    expect(isRetryableUpstreamError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true);
    expect(isRetryableUpstreamError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
    expect(isRetryableUpstreamError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(true);
  });

  it('is false for non-errors and unknown shapes', () => {
    expect(isRetryableUpstreamError(null)).toBe(false);
    expect(isRetryableUpstreamError('boom')).toBe(false);
    expect(isRetryableUpstreamError({})).toBe(false);
  });

  it('aiCallGuards gives one retry and a 45 s abort signal', () => {
    const guards = aiCallGuards();
    expect(guards.maxRetries).toBe(1);
    expect(guards.abortSignal).toBeInstanceOf(AbortSignal);
    expect(AI_CALL_TIMEOUT_MS).toBe(45_000);
  });
});
