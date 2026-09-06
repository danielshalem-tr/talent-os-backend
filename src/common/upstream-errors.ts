/**
 * Per-call ceiling for the small OpenRouter calls (classifier, extractor, matcher). Without it a
 * stalled upstream socket held the worker's single slot forever — lock renewal kept the job
 * "active", so BullMQ never noticed. Scoring keeps its own SCORING_TIMEOUT_MS (60 s).
 */
export const AI_CALL_TIMEOUT_MS = 45_000;

/** Spread into generateObject(): one SDK-level retry and a hard deadline. */
export function aiCallGuards(): { maxRetries: 1; abortSignal: AbortSignal } {
  return { maxRetries: 1, abortSignal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS) };
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);
const RETRYABLE_STATUS = new Set([402, 408, 409, 425, 429]);

type ErrorLike = {
  name?: string;
  code?: string;
  statusCode?: number;
  isRetryable?: boolean;
  lastError?: unknown;
  cause?: unknown;
};

/**
 * "Would the same call succeed once the provider is back?" Decides `held` (replayable) vs
 * `failed` (permanent) when a job has used every attempt.
 *
 * Duck-typed: the `ai` package is ESM-mocked in several specs, so its error classes cannot be
 * imported here. Shapes (verified against ai@6): `AI_APICallError` carries statusCode +
 * isRetryable (true for 408/409/429/5xx); 402 is OpenRouter "insufficient credits" — the 8-day
 * outage that lost 25 CVs. `AI_RetryError` wraps the last attempt in `lastError`.
 */
export function isRetryableUpstreamError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 3) return false;
  const e = err as ErrorLike;
  if (e.name === 'AI_RetryError') return isRetryableUpstreamError(e.lastError, depth + 1);
  if (e.name === 'AI_APICallError') {
    return (
      e.isRetryable === true ||
      (e.statusCode !== undefined && (RETRYABLE_STATUS.has(e.statusCode) || e.statusCode >= 500))
    );
  }
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  const code = e.code ?? (e.cause as ErrorLike | undefined)?.code;
  if (code && NETWORK_CODES.has(code)) return true;
  return isRetryableUpstreamError(e.cause, depth + 1);
}
