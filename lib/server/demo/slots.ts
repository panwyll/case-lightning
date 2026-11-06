/**
 * When a demo can be booked: the host's hours on any day but a bank holiday, a fixed length with a gap after, from a
 * little notice ahead to 72 hours out, less anything already in the diary (bookings, and the host's own busy
 * times from their published calendar). Pure: the same inputs give the same slots.
 */
import { EW_BANK_HOLIDAYS } from '../engine/working-days';
import { wallClock, zonedDate, zonedTime } from './time';

export interface DemoHours {
  tz: string;
  /** Days of the week, 0 Sunday … 6 Saturday. */
  days: number[];
  /** First and last start times, "09:30" and "16:30". */
  first: string;
  last: string;
  /** Meeting length and the step between starts (the difference is the gap after each). */
  minutes: number;
  step: number;
  /** How long ahead the earliest booking is, and how far ahead the latest may start. */
  noticeMinutes: number;
  horizonHours: number;
  holidays: ReadonlySet<string>;
}

const env = (k: string) => (process.env[k]?.trim() || undefined);
const hhmm = (v: string | undefined, d: string) => (v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);

export const DEMO_HOURS: DemoHours = {
  tz: 'Europe/London',
  days: [0, 1, 2, 3, 4, 5, 6],
  first: hhmm(env('DEMO_FIRST_START'), '09:30'),
  last: hhmm(env('DEMO_LAST_START'), '16:30'),
  minutes: 15,
  step: 30,
  noticeMinutes: 120,
  horizonHours: 72,
  holidays: EW_BANK_HOLIDAYS,
};

export interface Busy { start: Date; end: Date }
export interface SlotDay { date: string; times: string[] }

const overlaps = (a: Busy, b: Busy) => a.start < b.end && b.start < a.end;

/** Every bookable start, grouped by day (in the host's zone), earliest first. */
export function demoSlots(now: Date, busy: Busy[], hours: DemoHours = DEMO_HOURS): SlotDay[] {
  const out: SlotDay[] = [];
  const earliest = now.getTime() + hours.noticeMinutes * 60_000;
  const latest = now.getTime() + hours.horizonHours * 3_600_000;
  const [fh, fm] = hours.first.split(':').map(Number);
  const [lh, lm] = hours.last.split(':').map(Number);
  const today = wallClock(now, hours.tz);
  for (let i = 0; i <= Math.ceil(hours.horizonHours / 24); i++) {
    // Noon on the day in question, so a clock change never moves us onto the wrong date.
    const noon = zonedTime(today.y, today.m, today.d + i, 12, 0, hours.tz);
    const w = wallClock(noon, hours.tz);
    const date = zonedDate(noon, hours.tz);
    if (!hours.days.includes(w.dow) || hours.holidays.has(date)) continue;
    const times: string[] = [];
    for (let t = fh * 60 + fm; t <= lh * 60 + lm; t += hours.step) {
      const start = zonedTime(w.y, w.m, w.d, Math.floor(t / 60), t % 60, hours.tz);
      const slot = { start, end: new Date(start.getTime() + hours.minutes * 60_000) };
      if (start.getTime() < earliest || start.getTime() > latest || busy.some((b) => overlaps(slot, b))) continue;
      times.push(start.toISOString());
    }
    if (times.length) out.push({ date, times });
  }
  return out;
}
