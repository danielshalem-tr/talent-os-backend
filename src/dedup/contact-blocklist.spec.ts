import { mockCandidateExtract } from '../ingestion/services/extraction-agent.service.test-helpers';
import { applyContactBlocklist, isBlockedEmail, isBlockedPhone, parseContactBlocklist } from './contact-blocklist';

describe('parseContactBlocklist', () => {
  it('splits emails, @domains and phones; lower-cases; strips phone formatting', () => {
    const bl = parseContactBlocklist(' Office@Acme.io, @acme.io ,+1 (555) 010-0000,,');
    expect([...bl.emails]).toEqual(['office@acme.io']);
    expect([...bl.domains]).toEqual(['acme.io']);
    expect([...bl.phones]).toEqual(['15550100000']);
  });

  it('ignores phones under the digit floor and empty input', () => {
    expect(parseContactBlocklist('12345').phones.size).toBe(0);
    const empty = parseContactBlocklist(undefined);
    expect(empty.emails.size + empty.domains.size + empty.phones.size).toBe(0);
  });
});

describe('isBlockedEmail / isBlockedPhone', () => {
  const bl = parseContactBlocklist('office@acme.io,@agency.example,+1 555 010 0000');

  it('matches exact emails case-insensitively and whole domains only', () => {
    expect(isBlockedEmail('OFFICE@acme.io', bl)).toBe(true);
    expect(isBlockedEmail('someone@agency.example', bl)).toBe(true);
    expect(isBlockedEmail('someone@notagency.example', bl)).toBe(false);
    expect(isBlockedEmail('someone@sub.agency.example', bl)).toBe(false);
    expect(isBlockedEmail(null, bl)).toBe(false);
  });

  it('matches phones on digits regardless of formatting', () => {
    expect(isBlockedPhone('+1-555-010-0000', bl)).toBe(true);
    expect(isBlockedPhone('15550100000', bl)).toBe(true);
    expect(isBlockedPhone('+1 555 010 0001', bl)).toBe(false);
    expect(isBlockedPhone(null, bl)).toBe(false);
  });
});

describe('applyContactBlocklist', () => {
  const bl = parseContactBlocklist('@acme.io,+1 555 010 0000');

  it('nulls blocked fields, reports which, and leaves everything else untouched', () => {
    const extract = mockCandidateExtract({ email: 'hr@acme.io', phone: '+1 (555) 010-0000' });
    const result = applyContactBlocklist(extract, bl);
    expect(result.blocked).toEqual(['email', 'phone']);
    expect(result.extract).toEqual({ ...extract, email: null, phone: null });
  });

  it('is a no-op when nothing is blocked (same values, empty report)', () => {
    const extract = mockCandidateExtract({ email: 'jane@example.com', phone: '+1-555-0100' });
    const result = applyContactBlocklist(extract, bl);
    expect(result.blocked).toEqual([]);
    expect(result.extract).toEqual(extract);
  });
});
