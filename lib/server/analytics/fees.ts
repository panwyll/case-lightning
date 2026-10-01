/**
 * A case's fee from the firm's fee scale (lib/server/policy.ts FeeScale): the legal fee for its kind of case in the
 * band its price falls in, plus every add-on that applies to it, ex VAT, in pounds. Pure.
 */
import type { FeeScale } from '../policy';
import type { CaseSide } from './kpis';

/** What a fee scale can know about a case. */
export interface FeeFacts { side: CaseSide; price: number | null; leasehold: boolean; hasLender: boolean; idChecks: number; gifts: number; shapes: string[] }

/** When an add-on applies, and how many times. Shapes are the engine's case shapes (shapes.ts). */
export const FEE_CONDITIONS: Record<string, { label: string; count: (f: FeeFacts) => number }> = {
  always: { label: 'Every Case', count: () => 1 },
  leasehold: { label: 'Leasehold', count: (f) => (f.leasehold ? 1 : 0) },
  mortgage: { label: 'Acting For The Lender', count: (f) => (f.hasLender ? 1 : 0) },
  each_id_check: { label: 'Each Person ID Checked', count: (f) => f.idChecks },
  each_gift: { label: 'Each Gift Donor', count: (f) => f.gifts },
  new_build: { label: 'New Build', count: (f) => +f.shapes.includes('new_build') },
  buy_to_let: { label: 'Buy To Let', count: (f) => +f.shapes.includes('buy_to_let') },
  company_buyer: { label: 'Company Client', count: (f) => +f.shapes.includes('company_buyer') },
  auction: { label: 'Auction', count: (f) => +f.shapes.includes('auction') },
  isa: { label: 'Help To Buy Or Lifetime ISA', count: (f) => +(f.shapes.includes('lifetime_isa') || f.shapes.includes('help_to_buy_isa')) },
  shared_ownership: { label: 'Shared Ownership', count: (f) => +f.shapes.includes('shared_ownership') },
  right_to_buy: { label: 'Right To Buy', count: (f) => +f.shapes.includes('right_to_buy') },
  second_charge: { label: 'Second Charge', count: (f) => +f.shapes.includes('second_charge') },
};

/** The add-ons most firms charge, offered as one-click additions on the Fees settings. */
export const COMMON_EXTRAS: Array<{ label: string; when: string; sides: string[] }> = [
  { label: 'ID Check', when: 'each_id_check', sides: [] },
  { label: 'Leasehold Supplement', when: 'leasehold', sides: [] },
  { label: 'Acting For Your Lender', when: 'mortgage', sides: ['purchase', 'remortgage'] },
  { label: 'Gifted Deposit', when: 'each_gift', sides: ['purchase'] },
  { label: 'Bank Transfer', when: 'always', sides: [] },
  { label: 'SDLT Return', when: 'always', sides: ['purchase'] },
  { label: 'New Build', when: 'new_build', sides: ['purchase'] },
  { label: 'Help To Buy Or Lifetime ISA', when: 'isa', sides: ['purchase'] },
  { label: 'Buy To Let', when: 'buy_to_let', sides: ['purchase', 'remortgage'] },
  { label: 'Company Client', when: 'company_buyer', sides: [] },
  { label: 'Auction', when: 'auction', sides: [] },
  { label: 'Shared Ownership', when: 'shared_ownership', sides: [] },
];

export function feeBreakdown(scale: FeeScale | null, f: FeeFacts): { total: number; lines: Array<{ label: string; amount: number }> } | null {
  if (!scale || f.side === 'other') return null;
  const bands = [...(scale[f.side] ?? [])].filter((b) => b.fee > 0).sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  const lines: Array<{ label: string; amount: number }> = [];
  // No price on the case (a remortgage or transfer often has none): the lowest band.
  const band = !bands.length ? null : f.price == null ? bands[0] : bands.find((b) => b.upTo == null || f.price! <= b.upTo) ?? bands[bands.length - 1];
  if (band) lines.push({ label: 'Legal Fee', amount: band.fee });
  for (const x of scale.extras ?? []) {
    if (!(x.fee > 0) || (x.sides.length && !x.sides.includes(f.side))) continue;
    const n = FEE_CONDITIONS[x.when]?.count(f) ?? 0;
    if (n > 0) lines.push({ label: n > 1 ? `${x.label} × ${n}` : x.label, amount: x.fee * n });
  }
  return lines.length ? { total: lines.reduce((a, l) => a + l.amount, 0), lines } : null;
}

export const feeFor = (scale: FeeScale | null, f: FeeFacts): number | null => feeBreakdown(scale, f)?.total ?? null;

/** "£350,000", "350000", "£350k" → 350000; anything else → null. */
export function parsePrice(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = String(v).replace(/[£,\s]/g, '').match(/^(\d+(?:\.\d+)?)(k|m)?$/i);
  if (!m) return null;
  const n = Number(m[1]) * (m[2]?.toLowerCase() === 'k' ? 1e3 : m[2]?.toLowerCase() === 'm' ? 1e6 : 1);
  return n > 0 ? n : null;
}
