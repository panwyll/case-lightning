/**
 * What a conveyancer's time is worth: the basis the landing page's "every minute saved per case" figure, the
 * Measurement page's values and the free scan's calculators share. A conveyancer works 220 days of 7.5 hours and
 * completes 30 cases a month at £1,000 in fees each: 99,000 minutes over 360 cases is 275 minutes a case. Save one
 * minute a case and the same year holds 99,000 / 274 cases, 1.3 more, worth £1,314. The functions below take a firm's
 * own figures in place of these.
 */
export interface ValueInputs { workingDays: number; hoursPerDay: number; completionsPerMonth: number; averageFee: number }

export const VALUE_BASIS: ValueInputs = { workingDays: 220, hoursPerDay: 7.5, completionsPerMonth: 30, averageFee: 1000 };

/** One fee earner's working minutes in a year. */
export const yearMinutesOf = (v: ValueInputs) => v.workingDays * v.hoursPerDay * 60;

/** One fee earner's cases in a year. */
export const casesPerYearOf = (v: ValueInputs) => v.completionsPerMonth * 12;

/** Minutes of a fee earner's time each case takes, on average. */
export const minutesPerCaseOf = (v: ValueInputs) => yearMinutesOf(v) / casesPerYearOf(v);

/** A fee earner's fees in a year. */
export const yearFeesOf = (v: ValueInputs) => casesPerYearOf(v) * v.averageFee;

/** A minute saved on every case, for one fee earner for a year, in pounds: the extra cases the same year then holds, at the average fee. */
export function minuteValueOf(v: ValueInputs): number {
  const minutes = yearMinutesOf(v);
  const cases = casesPerYearOf(v);
  const per = minutes / cases;
  if (!(per > 1) || !(cases > 0)) return 0;
  return (minutes / (per - 1) - cases) * v.averageFee;
}

/** An hour a week of one fee earner's time, for a year, in pounds: the minutes it frees on each case at the rate above. */
export const weeklyHourValueOf = (v: ValueInputs) => (60 * (v.workingDays / 5)) / casesPerYearOf(v) * minuteValueOf(v);

/** A minute saved on every case, for one conveyancer for a year, in pounds: £1,314. */
export const MINUTE_PER_CASE_VALUE = Math.round(minuteValueOf(VALUE_BASIS));

/** An hour a week of one conveyancer's time, for a year, in pounds, on the standard basis. */
export const yearValueOfWeeklyHours = (hours: number) => hours * ((60 * (VALUE_BASIS.workingDays / 5)) / casesPerYearOf(VALUE_BASIS)) * MINUTE_PER_CASE_VALUE;

/** £50k, £9,600. */
export const pounds = (x: number) => (x >= 10_000 ? `£${Math.round(x / 1000)}k` : `£${Math.round(x).toLocaleString('en-GB')}`);

/** 4h 51m. */
export const hoursAndMinutes = (minutes: number) => {
  const m = Math.round(minutes);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
