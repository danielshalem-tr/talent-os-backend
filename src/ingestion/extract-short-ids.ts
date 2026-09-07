/**
 * Extract candidate short_ids from combined subject + body text. Short_ids are plain numbers
 * ≥ 100 with at most six digits (e.g. 106, 300, 1053). The downstream DB query still filters to
 * OPEN jobs, but that filter cannot tell intent from coincidence: "2020", "25,000" and the middle
 * of a phone number all used to reach it and, when a job with that number existed, reassigned
 * the candidate. Those shapes are excluded here.
 *
 * A standalone pure function so the live pipeline and the one-off retro script apply exactly
 * the same rule.
 */
export function extractShortIds(subject: string | null | undefined, body: string | null | undefined): string[] {
  const text = [subject, body].filter(Boolean).join(' ');
  if (!text) return [];

  const ids: string[] = [];
  for (const match of text.matchAll(/\b(\d{3,})\b/g)) {
    const digits = match[1];
    const start = match.index ?? 0;
    const prev = text[start - 1] ?? ' ';
    const prev2 = text[start - 2] ?? ' ';
    const next = text.slice(start + digits.length, start + digits.length + 5);

    if (digits.length > 6) continue; // phone fragments, tracking ids
    if (parseInt(digits, 10) < 100) continue;
    if (/^(19|20)\d{2}$/.test(digits)) continue; // a year
    if ('+$€₪'.includes(prev)) continue; // country code, money
    if ((prev === '-' || prev === '.' || prev === ',') && /\d/.test(prev2)) continue; // 052-123…, 25,000, 1.500
    if (/^[-.]\d/.test(next)) continue; // leading group of a phone / decimal
    if (/^[,\s]\d{3}(?!\d)/.test(next)) continue; // leading thousands group: 301,000 / 301 000
    if (/^\s?%/.test(next)) continue; // percentage
    ids.push(digits);
  }
  return [...new Set(ids)];
}
