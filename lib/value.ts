/**
 * What a conveyancer's time is worth: the basis the landing page's "every minute saved per case" figure and the
 * Measurement page's values share. A conveyancer works 220 days of 7.5 hours and completes 30 cases a month at £1,000
 * in fees each: 99,000 minutes over 360 cases is 275 minutes a case. Save one minute a case and the same year holds
 * 99,000 / 274 cases, 1.3 more, worth £1,314.
 */
export const VALUE_BASIS = { workingDays: 220, hoursPerDay: 7.5, completionsPerMonth: 30, averageFee: 1000 } as const;

const yearMinutes = VALUE_BASIS.workingDays * VALUE_BASIS.hoursPerDay * 60;
const casesPerYear = VALUE_BASIS.completionsPerMonth * 12;

/** A minute saved on every case, for one conveyancer for a year, in pounds: £1,314. */
export const MINUTE_PER_CASE_VALUE = Math.round((yearMinutes / (yearMinutes / casesPerYear - 1) - casesPerYear) * VALUE_BASIS.averageFee);

/** An hour a week of one conveyancer's time, for a year, in pounds: the minutes it frees on each case at the rate above. */
export const yearValueOfWeeklyHours = (hours: number) => (hours * 60 * (VALUE_BASIS.workingDays / 5) / casesPerYear) * MINUTE_PER_CASE_VALUE;

/** £50k, £9,600. */
export const pounds = (x: number) => (x >= 10_000 ? `£${Math.round(x / 1000)}k` : `£${Math.round(x).toLocaleString('en-GB')}`);
