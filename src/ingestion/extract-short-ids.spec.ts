import { extractShortIds } from './extract-short-ids';

describe('extractShortIds', () => {
  it('returns an empty array for empty input', () => {
    expect(extractShortIds(null, null)).toEqual([]);
    expect(extractShortIds('', '')).toEqual([]);
  });

  it('pulls 3+ digit numbers from the subject and body', () => {
    expect(extractShortIds('Application for #300', 'ref 106')).toEqual(['300', '106']);
  });

  it('ignores numbers below 100', () => {
    expect(extractShortIds('Job 42', null)).toEqual([]);
  });

  it('de-duplicates', () => {
    expect(extractShortIds('300', '300')).toEqual(['300']);
  });
  it('ignores years, phone numbers, money and percentages', () => {
    expect(
      extractShortIds('Senior dev 2020-2025', 'Salary 25,000 ILS, ₪30000, $5000, 052-1234567, +972521234567, 100% remote'),
    ).toEqual([]);
  });

  it('ignores the leading group of a thousands-separated amount', () => {
    expect(extractShortIds('', 'Expected salary: 301,000 NIS or 301 000 gross')).toEqual([]);
    expect(extractShortIds('', 'Job 301, starting 2026')).toEqual(['301']);
  });

  it('still matches hash-prefixed and bare job numbers, in order of appearance', () => {
    expect(extractShortIds('משרה 106', 'Also relevant for #300 and 1053.')).toEqual(['106', '300', '1053']);
  });

  it('caps at six digits', () => {
    expect(extractShortIds(null, 'ref 1234567')).toEqual([]);
    expect(extractShortIds(null, 'ref 123456')).toEqual(['123456']);
  });
});
