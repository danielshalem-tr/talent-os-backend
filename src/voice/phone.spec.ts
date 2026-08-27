import { normalizeToE164 } from './phone';

describe('normalizeToE164', () => {
  it('strips separators from an international number', () => {
    expect(normalizeToE164('+972-52-4203543')).toBe('+972524203543');
    expect(normalizeToE164('+972 52 420 3543')).toBe('+972524203543');
  });

  it('converts Israeli local format (leading 0) to +972', () => {
    expect(normalizeToE164('052-4203543')).toBe('+972524203543'); // mobile, 10 digits
    expect(normalizeToE164('09-7654321')).toBe('+97297654321'); // landline, 9 digits
  });

  it('adds + when the country code is present without it', () => {
    expect(normalizeToE164('972524203543')).toBe('+972524203543');
  });

  it('passes through non-Israeli international numbers', () => {
    expect(normalizeToE164('+1 (415) 555-0100')).toBe('+14155550100');
  });

  it('returns null for garbage, empty, too-short and too-long input', () => {
    expect(normalizeToE164(null)).toBeNull();
    expect(normalizeToE164(undefined)).toBeNull();
    expect(normalizeToE164('')).toBeNull();
    expect(normalizeToE164('no phone')).toBeNull();
    expect(normalizeToE164('12345')).toBeNull(); // 5 digits, no prefix rule matches
    expect(normalizeToE164('+12345678901234567890')).toBeNull(); // > 15 digits
  });

  it('returns null for local-looking numbers it cannot confidently place', () => {
    expect(normalizeToE164('4203543')).toBeNull(); // 7 digits, no leading 0, no country code
  });
});
