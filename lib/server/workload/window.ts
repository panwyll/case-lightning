/**
 * The window a mailbox scan reads: whole days in UK time, ending at midnight this morning, so neither end is a
 * part-day. A part-day would count as a whole working day while holding only some of its email, and the time before
 * the first email of a part-day could reach back outside the window. Today, still under way, is left out.
 */
import { wallClock, zonedTime } from '../demo/time';
import { EW_CALENDAR, isWorkingDay } from '../engine/working-days';
import { workingWeeks } from './model';

const TZ = 'Europe/London';

export function wholeDayWindow(now: Date, weeks: number): { since: Date; until: Date } {
  const w = wallClock(now, TZ);
  return { since: zonedTime(w.y, w.m, w.d - weeks * 7, 0, 0, TZ), until: zonedTime(w.y, w.m, w.d, 0, 0, TZ) };
}

const isMidnight = (at: Date) => { const w = wallClock(at, TZ); return w.h === 0 && w.min === 0; };

/**
 * Working weeks in a scan's window. A whole-day window (above) counts the UK dates it holds, Monday to Friday less
 * bank holidays, so a window across the clock change counts right. An older window with part-days at its ends falls
 * back to workingWeeks (workload/model.ts), as it was measured before.
 */
export function windowWeeks(since: Date, until: Date): number {
  if (!isMidnight(since) || !isMidnight(until)) return workingWeeks(since.toISOString(), until.toISOString());
  const w = wallClock(since, TZ);
  let n = 0;
  for (let i = 0; ; i++) {
    const noon = zonedTime(w.y, w.m, w.d + i, 12, 0, TZ);
    if (noon.getTime() >= until.getTime()) break;
    // Noon UK time is the same date in UTC, which is what the calendar reads.
    if (isWorkingDay(noon, EW_CALENDAR)) n += 1;
  }
  return Math.max(0.2, n / 5);
}
