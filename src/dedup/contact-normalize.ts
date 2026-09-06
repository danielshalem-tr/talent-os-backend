/** A phone with fewer digits than this is junk ('-', '0', an extension) and is treated as "no phone". */
export const MIN_PHONE_DIGITS = 7;

/**
 * Digit-only form of a phone number, or null when there is nothing usable. Dedup compares
 * this form on both sides (the SQL side uses regexp_replace(phone, '[^0-9]', '', 'g')), so two
 * spellings of one number always agree, and two junk values can never match each other.
 */
export function phoneDigits(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= MIN_PHONE_DIGITS ? digits : null;
}

/**
 * Trimmed email or null. Case is preserved on purpose: idx_candidates_tenant_email_unique is a
 * plain (case-sensitive) unique index, and dedup must find exactly what the index would reject.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
