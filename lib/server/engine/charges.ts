/**
 * Every charge on a sale (docs/eventualities/completion.md §4; theme D).
 *
 * The existing mortgage keeps its own flow (`s.redemption`). Any other charge on the register (a second
 * charge, a secured loan, a charging order, a Help to Buy equity loan) is one more entry here: its
 * redemption figure before exchange, paid on completion, its discharge chased afterwards. The total
 * owed against the price is checked (negative equity), and the undertaking we give the buyer's
 * solicitor covers them all. Pure: the machine raises the events.
 */
import type { MatterState, OtherCharge, TitleFacts } from './types';

/** A charge securing money, as opposed to a notice, a restriction or a covenant that sits in the charges register. */
export const isFinancialCharge = (text: string): boolean => /\b(charge|mortgage|secured loan|charging order|legal charge)\b/i.test(text) && !/home rights|unilateral notice|agreed notice|caution|restriction|covenant|lease dated/i.test(text);

/** Who the charge is in favour of, as the register says. */
export function chargeeOf(text: string): string {
  const m = text.match(/in favour of\s+([^.;\n]+?)(?:\s+(?:dated|for|to secure|registered on)\b|[.;\n]|$)/i) ?? text.match(/(?:proprietor|chargee)[^:]*:\s*([^.;\n]+)/i);
  return (m?.[1] ?? text).replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Charges on the title beyond the existing mortgage (which is `s.redemption`), not yet on the case. */
export function chargesToAdd(s: MatterState, t: TitleFacts): Array<{ chargee: string; text: string }> {
  const financial = t.charges.filter((c) => isFinancialCharge(c.text));
  const beyondMain = s.hasExistingMortgage ? financial.slice(1) : financial;
  const known = new Set((s.otherCharges ?? []).map((c) => (c.text ?? c.chargee).toLowerCase()));
  return beyondMain.filter((c) => !known.has(c.text.toLowerCase())).map((c) => ({ chargee: chargeeOf(c.text), text: c.text }));
}

export const openCharges = (s: MatterState): OtherCharge[] => (s.otherCharges ?? []).filter((c) => c.status !== 'discharged');

/** What is owed against the property on a sale, and how far it exceeds the price (null: nothing to compare). */
export function negativeEquity(s: MatterState): { owedPennies: number; pricePennies: number; shortPennies: number } | null {
  const price = s.purchasePricePennies ?? null;
  if (!price) return null;
  const main = s.hasExistingMortgage ? s.redemption.redemptionPennies ?? null : 0;
  const others = (s.otherCharges ?? []).map((c) => c.redemptionPennies);
  if (main == null && !others.some((x) => x != null)) return null;
  const owed = (main ?? 0) + others.reduce<number>((a, x) => a + (x ?? 0), 0);
  return { owedPennies: owed, pricePennies: price, shortPennies: Math.max(0, owed - price) };
}

/** Everything charged is discharged: the main mortgage (if any) and every other charge. */
export const allDischarged = (s: MatterState): boolean => (!s.hasExistingMortgage || s.redemption.status === 'discharged' || s.redemption.status === 'not_required') && openCharges(s).length === 0;

/** Something is charged that the sale must clear. */
export const anythingCharged = (s: MatterState): boolean => (s.hasExistingMortgage && s.redemption.status !== 'not_required') || (s.otherCharges ?? []).length > 0;
