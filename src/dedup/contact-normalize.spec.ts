import { MIN_PHONE_DIGITS, normalizeEmail, phoneDigits } from './contact-normalize';

describe('phoneDigits', () => {
  it('strips every non-digit character', () => {
    expect(phoneDigits('+972 (54) 123-4567')).toBe('972541234567');
    expect(phoneDigits('054.123.4567')).toBe('0541234567');
  });

  it('treats null, blank and short values as no phone', () => {
    expect(phoneDigits(null)).toBeNull();
    expect(phoneDigits(undefined)).toBeNull();
    expect(phoneDigits('')).toBeNull();
    expect(phoneDigits('   ')).toBeNull();
    // Junk the extractor has produced in production: '-' normalises to '' and matched every other junk phone.
    expect(phoneDigits('-')).toBeNull();
    expect(phoneDigits('123456')).toBeNull();
  });

  it(`accepts exactly ${MIN_PHONE_DIGITS} digits`, () => {
    expect(phoneDigits('1234567')).toBe('1234567');
  });
});

describe('normalizeEmail', () => {
  it('trims and returns null for blank', () => {
    expect(normalizeEmail('  a@b.com ')).toBe('a@b.com');
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it('does NOT change case — the DB unique index on email is case-sensitive and dedup must match it', () => {
    expect(normalizeEmail('Jane@Example.com')).toBe('Jane@Example.com');
  });
});
