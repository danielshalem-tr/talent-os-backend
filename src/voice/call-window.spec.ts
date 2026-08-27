import { isInBusinessWindow, nextBusinessWindowSlot } from './call-window';

describe('call-window (Sun–Thu 09:00–19:00 Asia/Jerusalem)', () => {
  describe('isInBusinessWindow', () => {
    it('true inside the window (Thu 10:00 IL = 07:00 UTC in August/IDT)', () => {
      expect(isInBusinessWindow(new Date('2026-08-27T07:00:00Z'))).toBe(true);
    });
    it('true at 18:59, false at 19:00 sharp', () => {
      expect(isInBusinessWindow(new Date('2026-08-27T15:59:00Z'))).toBe(true); // 18:59 IL
      expect(isInBusinessWindow(new Date('2026-08-27T16:00:00Z'))).toBe(false); // 19:00 IL
    });
    it('true at 09:00 sharp, false at 08:59', () => {
      expect(isInBusinessWindow(new Date('2026-08-27T06:00:00Z'))).toBe(true); // 09:00 IL
      expect(isInBusinessWindow(new Date('2026-08-27T05:59:00Z'))).toBe(false); // 08:59 IL
    });
    it('false on Friday and Saturday even inside working hours', () => {
      expect(isInBusinessWindow(new Date('2026-08-28T08:00:00Z'))).toBe(false); // Fri 11:00 IL
      expect(isInBusinessWindow(new Date('2026-08-29T08:00:00Z'))).toBe(false); // Sat 11:00 IL
    });
  });

  describe('nextBusinessWindowSlot', () => {
    it('returns now unchanged when already inside the window', () => {
      const now = new Date('2026-08-27T07:00:00Z');
      expect(nextBusinessWindowSlot(now).getTime()).toBe(now.getTime());
    });
    it('Thu 19:30 IL → Sun 09:00 IL (weekend skipped)', () => {
      const slot = nextBusinessWindowSlot(new Date('2026-08-27T16:30:00Z'));
      expect(slot.toISOString()).toBe('2026-08-30T06:00:00.000Z'); // Sun 09:00 IDT
    });
    it('Friday CV → Sunday 09:00 IL', () => {
      const slot = nextBusinessWindowSlot(new Date('2026-08-28T08:00:00Z'));
      expect(slot.toISOString()).toBe('2026-08-30T06:00:00.000Z');
    });
    it('same-day early morning → same-day 09:00 IL', () => {
      const slot = nextBusinessWindowSlot(new Date('2026-08-27T04:00:00Z')); // Thu 07:00 IL
      expect(slot.toISOString()).toBe('2026-08-27T06:00:00.000Z'); // Thu 09:00 IDT
    });
    it('handles winter time (IST=UTC+2): Wed 20:00 IL → Thu 09:00 IL = 07:00 UTC', () => {
      const slot = nextBusinessWindowSlot(new Date('2026-12-30T18:00:00Z')); // Wed 20:00 IST
      expect(slot.toISOString()).toBe('2026-12-31T07:00:00.000Z'); // Thu 09:00 IST
    });
    it('is independent of the ambient process TZ', () => {
      const prev = process.env.TZ;
      process.env.TZ = 'UTC';
      try {
        const slot = nextBusinessWindowSlot(new Date('2026-08-28T08:00:00Z'));
        expect(slot.toISOString()).toBe('2026-08-30T06:00:00.000Z');
      } finally {
        process.env.TZ = prev;
      }
    });
  });
});
