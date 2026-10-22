/**
 * Wall-clock time in a named zone, without a library: what an instant reads as in Europe/London, and which
 * instant a London wall-clock time is (summer time included). Built on Intl, which carries the zone rules.
 */

export interface WallClock { y: number; m: number; d: number; h: number; min: number; dow: number }

const fmt = new Map<string, Intl.DateTimeFormat>();
const formatter = (tz: string) => {
  let f = fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
    fmt.set(tz, f);
  }
  return f;
};
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** What the instant reads as on a clock in the zone. */
export function wallClock(at: Date, tz: string): WallClock {
  const p = Object.fromEntries(formatter(tz).formatToParts(at).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, dow: DOW[p.weekday] ?? 0 };
}

const offsetMs = (ms: number, tz: string) => {
  const w = wallClock(new Date(ms), tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - Math.floor(ms / 60_000) * 60_000;
};

/** The instant a wall-clock time in the zone names (a time skipped by the clocks going forward lands just after). */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = offsetMs(guess, tz);
  let t = guess - first;
  const second = offsetMs(t, tz);
  if (second !== first) t = guess - second;
  return new Date(t);
}

/** "2026-10-23" for the instant's date in the zone. */
export const zonedDate = (at: Date, tz: string) => { const w = wallClock(at, tz); return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`; };

/** Whether the zone name is one Intl knows. */
export function knownZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}
