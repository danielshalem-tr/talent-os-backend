/**
 * The extraction LLM sometimes returns the *string* "null" (or "none", "N/A") where the
 * schema allows a real null. Stored verbatim, that renders in the UI as a literal "null"
 * location on the candidate card. Normalize at the boundary so nothing downstream —
 * database, mappers, UI — ever has to know about it.
 *
 * Only whole-value matches count: "Nullarbor" and "Nanaimo" are real place names.
 */
const NULLISH_VALUES = new Set(['null', 'none', 'n/a', 'na', 'undefined', '']);

export function normalizeNullishString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return NULLISH_VALUES.has(trimmed.toLowerCase()) ? null : trimmed;
}
