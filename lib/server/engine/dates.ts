/**
 * Dates and clocks (docs/eventualities/README.md theme E; property.md 2, 3, 8; exchange.md 5.6; completion.md 6).
 *
 * A completion date is a banking day the lender's offer still covers; searches are aged at completion from the
 * date they were made, not the day they reached us; and the clocks the law or a scheme sets (first registration
 * within two months, a LISA's 90 days, an auction's 20 working days, a new build's long-stop) are watched.
 */
import { isWorkingDay, addWorkingDays, EW_CALENDAR, type WorkingCalendar } from './working-days';
import type { MatterState } from './types';

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`);
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Why a completion date cannot be used, or null. `from` is the exchange (or today) it is set from. */
export function completionDateProblem(s: MatterState, date: string, from: Date, cal: WorkingCalendar = EW_CALENDAR): string | null {
  const d = day(date);
  if (Number.isNaN(d.getTime())) return 'A valid completion date is required.';
  if (date.slice(0, 10) < from.toISOString().slice(0, 10)) return `${date.slice(0, 10)} is before ${from.toISOString().slice(0, 10)}: a completion date cannot be in the past.`;
  if (!isWorkingDay(d, cal)) return `${date.slice(0, 10)} is a ${d.getUTCDay() === 0 || d.getUTCDay() === 6 ? WEEKDAY[d.getUTCDay()] : 'bank holiday'}: CHAPS and HM Land Registry are closed, so completion cannot happen that day.`;
  const expiry = (s.mortgage.facts as { expiryDate?: string | null } | null)?.expiryDate ?? null;
  if (s.hasLender && expiry && date.slice(0, 10) > expiry.slice(0, 10)) return `The mortgage offer expires on ${expiry.slice(0, 10)}, before ${date.slice(0, 10)}: get an extension or a fresh offer first, or choose an earlier date.`;
  return null;
}

/** How old a search will be, in months, on a given day: from the date it was made where the result says, else when it reached us. */
export function searchAgeMonths(s: MatterState, searchType: string, on: Date): number | null {
  const sr = s.searches[searchType];
  const made = (sr?.facts as { searchDate?: string | null } | null | undefined)?.searchDate ?? sr?.returnedAt ?? null;
  if (!made) return null;
  return (on.getTime() - Date.parse(made)) / (30.44 * 86_400_000);
}

/** The searches past the lender's age limit on the completion day. */
export function staleAtCompletion(s: MatterState, completionDate: string): string[] {
  const max = s.lenderRequirements?.maxSearchAgeMonths ?? null;
  if (max == null) return [];
  const on = day(completionDate);
  return Object.keys(s.searches).filter((t) => (searchAgeMonths(s, t, on) ?? 0) > max).map((t) => {
    const sr = s.searches[t];
    const made = (sr?.facts as { searchDate?: string | null } | null | undefined)?.searchDate ?? sr?.returnedAt ?? '';
    return `${t} (made ${made.slice(0, 10)})`;
  });
}

/** Two months from completion to apply for first registration, or the legal estate reverts (LRA 2002 ss.6-7). */
export function firstRegistrationDue(s: MatterState): string | null {
  if (!(s.title.facts as { unregistered?: boolean | null } | null)?.unregistered || !s.completion.confirmedAt) return null;
  const c = new Date(s.completion.confirmedAt);
  const d = new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 2, c.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

/** A Lifetime ISA's bonus must be used within 90 days of the conveyancer receiving it, or it goes back to the ISA manager. */
export function lisaWindowEnds(s: MatterState, receivedAt: string | null): string | null {
  if (!s.shapes?.includes('lifetime_isa') || !receivedAt || s.completion.confirmedAt) return null;
  return new Date(Date.parse(receivedAt) + 90 * 86_400_000).toISOString().slice(0, 10);
}

/** When the ISA bonus reached us: the ISA manager's funds wait closing. */
export const isaReceivedAt = (s: MatterState): string | null => s.waits.filter((w) => w.key === 'funds' && w.subject === 'isa_provider' && w.closedAt).map((w) => w.closedAt!).sort()[0] ?? null;

/** Auction contracts complete 20 working days after the auction (the Common Auction Conditions). */
export function auctionCompletionDue(s: MatterState, cal: WorkingCalendar = EW_CALENDAR): string | null {
  if (!s.shapes?.includes('auction') || !s.exchange.exchangedAt || s.completion.confirmedAt) return null;
  return addWorkingDays(new Date(s.exchange.exchangedAt), 20, cal).toISOString().slice(0, 10);
}

