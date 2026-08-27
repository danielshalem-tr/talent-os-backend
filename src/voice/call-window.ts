// Business-hours window for outbound screening calls: Sun–Thu 09:00–19:00 Asia/Jerusalem.
// All math goes through Intl with an explicit timeZone — NEVER ambient process TZ: the API
// pins TZ=Asia/Jerusalem (main.ts) but the worker container runs UTC.

const ZONE = 'Asia/Jerusalem';
const OPEN_HOUR = 9;
const CLOSE_HOUR = 19;
// Sun=0 … Sat=6; business days Sun–Thu
const BUSINESS_DAYS = new Set([0, 1, 2, 3, 4]);
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_MS = 86_400_000;

interface ZonedParts {
  year: number;
  month: number; // 1-based
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

const FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function jerusalemParts(date: Date): ZonedParts {
  const parts = FORMATTER.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAYS[get('weekday')],
    // Some ICU builds emit "24" for midnight with hour12: false
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

export function isInBusinessWindow(date: Date): boolean {
  const p = jerusalemParts(date);
  return BUSINESS_DAYS.has(p.weekday) && p.hour >= OPEN_HOUR && p.hour < CLOSE_HOUR;
}

// UTC instant for a Jerusalem wall-clock time. Two-pass correction: guess the wall time as
// UTC, measure the Jerusalem wall clock that instant produces, correct by the difference.
// Converges immediately for Israel's fixed IST/IDT offsets (UTC+2/UTC+3).
function utcForJerusalemWallClock(year: number, month: number, day: number, hour: number, minute: number): Date {
  let ts = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const p = jerusalemParts(new Date(ts));
    const gotMinutes = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 60_000;
    const wantMinutes = Date.UTC(year, month - 1, day, hour, minute) / 60_000;
    const diff = gotMinutes - wantMinutes;
    if (diff === 0) break;
    ts -= diff * 60_000;
  }
  return new Date(ts);
}

/**
 * Next moment a call may be placed: `now` itself when already inside the window,
 * otherwise the next Sun–Thu 09:00 Asia/Jerusalem (as a UTC instant).
 */
export function nextBusinessWindowSlot(now: Date): Date {
  if (isInBusinessWindow(now)) return now;
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * DAY_MS);
    const p = jerusalemParts(probe);
    if (!BUSINESS_DAYS.has(p.weekday)) continue;
    const slot = utcForJerusalemWallClock(p.year, p.month, p.day, OPEN_HOUR, 0);
    if (slot.getTime() > now.getTime()) return slot;
  }
  // Unreachable: any 8-day span contains a Sun–Thu 09:00.
  throw new Error('nextBusinessWindowSlot: no slot found within 8 days');
}
