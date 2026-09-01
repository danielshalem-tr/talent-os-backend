/**
 * Extract candidate short_ids from combined subject + body text.
 * Short_ids are plain numbers >= 100 (e.g., 100, 245, 1053).
 * Returns array of candidate short_id strings (may include false positives
 * like years or zip codes — the downstream DB query filters those out).
 *
 * A standalone pure function so the live pipeline and the one-off retro script
 * apply exactly the same rule.
 */
export function extractShortIds(subject: string | null | undefined, body: string | null | undefined): string[] {
  const combinedText = [subject, body].filter(Boolean).join(' ');

  if (!combinedText) return [];

  // Match all 3+ digit numbers as word boundaries
  const numberPattern = /\b(\d{3,})\b/g;
  const matches = [...combinedText.matchAll(numberPattern)];

  if (matches.length === 0) return [];

  // Filter >= 100, deduplicate, keep as strings (shortId is string type in DB)
  return [...new Set(matches.map((m) => m[1]).filter((s) => parseInt(s, 10) >= 100))];
}
