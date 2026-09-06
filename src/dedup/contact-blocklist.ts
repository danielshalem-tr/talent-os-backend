import { CandidateExtract } from '../ingestion/services/extraction-agent.service';
import { normalizeEmail, phoneDigits } from './contact-normalize';

/**
 * Tenant staff / agency contact details that must never be attributed to a candidate.
 * Early intake copied the forwarder's phone onto applicants; every later applicant with that
 * phone then "matched" the first one. Blocked values are nulled BEFORE dedup and BEFORE insert,
 * so they neither create matches nor land on a candidate row (spec D3).
 *
 * Source: env INTAKE_CONTACT_BLOCKLIST — comma-separated `user@host` (exact email),
 * `@host` (whole domain), or a phone number (digits compared after stripping).
 */
export interface ContactBlocklist {
  emails: Set<string>;
  domains: Set<string>;
  phones: Set<string>;
}

export type BlockedField = 'email' | 'phone';

export function parseContactBlocklist(raw: string | null | undefined): ContactBlocklist {
  const out: ContactBlocklist = { emails: new Set(), domains: new Set(), phones: new Set() };
  for (const entry of (raw ?? '').split(',')) {
    const value = entry.trim().toLowerCase();
    if (value === '') continue;
    if (value.startsWith('@')) {
      out.domains.add(value.slice(1));
    } else if (value.includes('@')) {
      out.emails.add(value);
    } else {
      const digits = phoneDigits(value);
      if (digits) out.phones.add(digits);
    }
  }
  return out;
}

export function isBlockedEmail(email: string | null | undefined, bl: ContactBlocklist): boolean {
  const normalized = normalizeEmail(email)?.toLowerCase();
  if (!normalized) return false;
  if (bl.emails.has(normalized)) return true;
  const at = normalized.lastIndexOf('@');
  return at > 0 && bl.domains.has(normalized.slice(at + 1));
}

export function isBlockedPhone(phone: string | null | undefined, bl: ContactBlocklist): boolean {
  const digits = phoneDigits(phone);
  return digits !== null && bl.phones.has(digits);
}

export function applyContactBlocklist(
  extract: CandidateExtract,
  bl: ContactBlocklist,
): { extract: CandidateExtract; blocked: BlockedField[] } {
  const blocked: BlockedField[] = [];
  const next: CandidateExtract = { ...extract };
  if (isBlockedEmail(extract.email, bl)) {
    next.email = null;
    blocked.push('email');
  }
  if (isBlockedPhone(extract.phone, bl)) {
    next.phone = null;
    blocked.push('phone');
  }
  return { extract: next, blocked };
}
