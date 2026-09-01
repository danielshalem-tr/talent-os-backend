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
});
