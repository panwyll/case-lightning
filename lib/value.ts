/**
 * What a conveyancer's time is worth: the basis the landing page's "every minute saved per case" figure and the
 * Measurement page's values share. A conveyancer works 220 days of 7.5 hours and completes 30 cases a month at £1,000
 * in fees each: 99,000 minutes over 360 cases is 275 minutes a case. Save s minutes a case and the same year holds
 * 99,000 / (275 − s) cases. The first minute is worth £1,314; each one after is worth more, and saving half of every
 * case doubles the cases: £360,000.
 */
export const VALUE_BASIS = { workingDays: 220, hoursPerDay: 7.5, completionsPerMonth: 30, averageFee: 1000 } as const;

const yearMinutes = VALUE_BASIS.workingDays * VALUE_BASIS.hoursPerDay * 60;
const casesPerYear = VALUE_BASIS.completionsPerMonth * 12;
/** 275. */
export const MINUTES_PER_CASE = yearMinutes / casesPerYear;

/** The extra fees a year from one conveyancer saving this many minutes on every case. */
export const yearValueOfMinutesSaved = (minutes: number) =>
  minutes <= 0 ? 0 : (yearMinutes / Math.max(1, MINUTES_PER_CASE - minutes) - casesPerYear) * VALUE_BASIS.averageFee;

/** The first minute saved on every case, for one conveyancer for a year, in pounds: £1,314. */
export const MINUTE_PER_CASE_VALUE = Math.round(yearValueOfMinutesSaved(1));

/** Double the cases: £360,000 a conveyancer a year. */
export const DOUBLING_VALUE = yearValueOfMinutesSaved(MINUTES_PER_CASE / 2);

/** Hours a week of one conveyancer's time, as minutes on each case. */
export const minutesPerCase = (weeklyHours: number) => (weeklyHours * 60 * (VALUE_BASIS.workingDays / 5)) / casesPerYear;

/** Hours a week of one conveyancer's time saved, on their own, worth a year. */
export const yearValueOfWeeklyHours = (hours: number) => yearValueOfMinutesSaved(minutesPerCase(hours));

/** £50k, £9,600. */
export const pounds = (x: number) => (x >= 10_000 ? `£${Math.round(x / 1000)}k` : `£${Math.round(x).toLocaleString('en-GB')}`);
