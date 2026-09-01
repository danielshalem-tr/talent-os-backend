import { normalizeNullishString } from './normalize-nullish';

describe('normalizeNullishString', () => {
  const nullish = ['null', 'NULL', 'Null', 'none', 'None', 'n/a', 'N/A', 'na', 'undefined', '', '   '];
  it.each(nullish)('maps %j to null', (value) => {
    expect(normalizeNullishString(value)).toBeNull();
  });

  it('maps real null and undefined to null', () => {
    expect(normalizeNullishString(null)).toBeNull();
    expect(normalizeNullishString(undefined)).toBeNull();
  });

  const kept: Array<[string, string]> = [
    ['Tel Aviv, Israel', 'Tel Aviv, Israel'],
    ['  Haifa, Israel  ', 'Haifa, Israel'],
    ['Nullarbor', 'Nullarbor'],
    ['Nanaimo, Canada', 'Nanaimo, Canada'],
  ];
  it.each(kept)('keeps %j as %j', (input, expected) => {
    expect(normalizeNullishString(input)).toBe(expected);
  });
});
