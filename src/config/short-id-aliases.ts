/**
 * A live external job ad can quote the wrong number — job #106 was advertised as
 * "#300", so every applicant's email carried an id no job has and all 360 of them
 * landed unassigned. SHORT_ID_ALIASES maps such a wrong number onto the real
 * `jobs.short_id`, applied between the text parse and the DB lookup so the rest of
 * the pipeline is unchanged.
 *
 * Format: comma-separated `from:to` pairs, e.g. "300:106,301:107".
 * Both sides are strings — `short_id` is a text column, not an integer.
 */
export function parseShortIdAliases(raw: string | null | undefined): Map<string, string> {
  const aliases = new Map<string, string>();
  if (!raw) return aliases;

  for (const pair of raw.split(',')) {
    const [from, to] = pair.split(':').map((part) => part?.trim() ?? '');
    // Silently skip malformed entries: a typo in an env var must never stop the worker booting.
    if (!from || !to) continue;
    aliases.set(from, to);
  }

  return aliases;
}

/**
 * Rewrite each extracted short_id through the alias map, de-duplicating the result.
 * An email quoting BOTH the wrong and the right number therefore still resolves to
 * exactly one job rather than creating two applications.
 */
export function applyShortIdAliases(ids: string[], aliases: Map<string, string>): string[] {
  if (aliases.size === 0) return [...new Set(ids)];
  return [...new Set(ids.map((id) => aliases.get(id) ?? id))];
}
