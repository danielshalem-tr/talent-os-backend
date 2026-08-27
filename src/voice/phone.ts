// E.164 normalization for outbound dialing. The pipeline stores phones as free-form
// LLM output (e.g. "+972-52-4203543", "052-4203543"); ElevenLabs/Twilio require strict
// E.164 ("+972524203543"). Returns null when the number can't be normalized confidently —
// callers MUST treat null as "do not dial".
export function normalizeToE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('972')) return `+${digits}`;
  // Israeli local format: mobile 05X-XXXXXXX (10 digits), landline 0X-XXXXXXX (9 digits)
  if (digits.startsWith('0') && (digits.length === 9 || digits.length === 10)) {
    return `+972${digits.slice(1)}`;
  }
  return null;
}
