import { parseShortIdAliases, applyShortIdAliases } from './short-id-aliases';

describe('parseShortIdAliases', () => {
  it('returns an empty map for unset or blank input', () => {
    expect(parseShortIdAliases(undefined).size).toBe(0);
    expect(parseShortIdAliases(null).size).toBe(0);
    expect(parseShortIdAliases('').size).toBe(0);
    expect(parseShortIdAliases('   ').size).toBe(0);
  });

  it('parses a single pair', () => {
    expect([...parseShortIdAliases('300:106')]).toEqual([['300', '106']]);
  });

  it('parses multiple pairs and trims whitespace', () => {
    expect([...parseShortIdAliases(' 300:106 , 301 : 107 ')]).toEqual([
      ['300', '106'],
      ['301', '107'],
    ]);
  });

  it('ignores malformed entries instead of throwing', () => {
    expect([...parseShortIdAliases('300,301:107,:108,109:')]).toEqual([['301', '107']]);
  });
});

describe('applyShortIdAliases', () => {
  const aliases = parseShortIdAliases('300:106');

  it('rewrites an aliased id', () => {
    expect(applyShortIdAliases(['300'], aliases)).toEqual(['106']);
  });

  it('passes an unaliased id through', () => {
    expect(applyShortIdAliases(['999'], aliases)).toEqual(['999']);
  });

  it('deduplicates when the alias and its target both appear', () => {
    expect(applyShortIdAliases(['300', '106'], aliases)).toEqual(['106']);
  });

  it('is a no-op with an empty alias map', () => {
    expect(applyShortIdAliases(['300', '106'], new Map())).toEqual(['300', '106']);
  });
});
