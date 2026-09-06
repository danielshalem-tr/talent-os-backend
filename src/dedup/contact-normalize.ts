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
 * Trimmed email or null. Case is preserved for STORAGE (mailbox case is technically
 * significant); every lookup, lock and the unique index compare case-insensitively via
 * emailIdentity() / lower(email).
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * Case-folded email, used ONLY to decide whether two rows are the same human.
 *
 * Writes and the DB unique index keep the original case (see normalizeEmail) — mailbox case
 * is technically significant. But identity is a different question: nobody is two applicants
 * because they capitalised their address. Comparing case-sensitively here left real duplicates
 * unmerged in production ("Snir1603@" vs "snir1603@" on one phone).
 */
export function emailIdentity(raw: string | null | undefined): string | null {
  return normalizeEmail(raw)?.toLowerCase() ?? null;
}
