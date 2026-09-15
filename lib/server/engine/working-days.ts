/**
 * England & Wales working-day arithmetic for the SLA/timer system.
 *
 * Conveyancing SLAs are quoted in WORKING days ("searches back in 10 working days"),
 * so the timer layer counts Mon–Fri excluding bank holidays. The holiday list is a
 * static table (gov.uk "UK bank holidays", England & Wales) covering the years a live
 * matter can span; extend it when a new year is published. Pure functions, UTC dates.
 */

/** England & Wales bank holidays. Substitute days included where the holiday falls at a weekend. */
export const EW_BANK_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2025
  '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-05', '2025-05-26', '2025-08-25', '2025-12-25', '2025-12-26',
  // 2026
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  // 2027
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
]);

export interface WorkingCalendar {
  /** ISO dates (YYYY-MM-DD) that are not working days in addition to weekends. */
  holidays: ReadonlySet<string>;
}

export const EW_CALENDAR: WorkingCalendar = { holidays: EW_BANK_HOLIDAYS };

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

const startOfUtcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function isWorkingDay(d: Date, cal: WorkingCalendar = EW_CALENDAR): boolean {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !cal.holidays.has(isoDate(d));
}

/**
 * Whole working days elapsed from `from` to `to` (exclusive of `from`'s day,
 * inclusive of `to`'s day when it is a working day). "Ordered Monday, it is now
 * Wednesday" → 2. Never negative.
 */
export function workingDaysBetween(from: Date, to: Date, cal: WorkingCalendar = EW_CALENDAR): number {
  let cursor = startOfUtcDay(from);
  const end = startOfUtcDay(to);
  if (end <= cursor) return 0;
  let n = 0;
  while (cursor < end) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    if (isWorkingDay(cursor, cal)) n += 1;
  }
  return n;
}

/** The date `n` working days after `from` (n ≥ 0). */
export function addWorkingDays(from: Date, n: number, cal: WorkingCalendar = EW_CALENDAR): Date {
  let cursor = startOfUtcDay(from);
  let left = n;
  while (left > 0) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    if (isWorkingDay(cursor, cal)) left -= 1;
  }
  return cursor;
}
