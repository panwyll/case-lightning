/**
 * Co-owners' money on the case (theme I; money.md 10.6, 10.7; docs/co-ownership.md).
 *
 * What each buyer puts in, recorded against the declaration of trust's model, gives each owner's share at purchase
 * (the calculator in co-ownership.ts). Unequal money held as joint tenants is the classic trap (on a death the survivor
 * takes everything; on a split each is presumed to own half: Stack v Dowden), so it is raised for advice; tenants in
 * common unequally need the figures before the declaration can be drawn up.
 */
import { currentShares, type Contribution, type Owner, type TrustModel, type TrustTerms } from './co-ownership';
import type { MatterState } from './types';

export interface ContributionInput { party: string; pennies: number }
export interface CoOwnershipRecord { model: TrustModel; contributions: ContributionInput[]; ratioPercent: Record<string, number> | null; shares: Array<{ party: string; shareBp: number }>; recordedAt: string }

const asOwners = (cs: ContributionInput[]): Owner[] => cs.map((c, i) => ({ id: `o${i + 1}`, name: c.party }));

/** Each owner's share on the day of purchase under the model: what the deed of trust starts from. */
export function sharesAtPurchase(s: Pick<MatterState, 'purchasePricePennies' | 'mortgage' | 'hasLender'>, model: TrustModel, cs: ContributionInput[], ratioPercent: Record<string, number> | null, today: string): Array<{ party: string; shareBp: number }> {
  const owners = asOwners(cs);
  const price = s.purchasePricePennies ?? cs.reduce((a, c) => a + c.pennies, 0);
  const mortgage = s.hasLender ? ((s.mortgage.facts as { amountPennies?: number } | null)?.amountPennies ?? Math.max(0, price - cs.reduce((a, c) => a + c.pennies, 0))) : 0;
  const contributions: Contribution[] = cs.map((c, i) => ({ ownerId: owners[i].id, type: 'DEPOSIT', pennies: c.pennies, date: today }));
  const ratio = ratioPercent ? Object.fromEntries(owners.map((o) => [o.id, Math.round((ratioPercent[o.name] ?? 0) * 100)])) : undefined;
  const terms: TrustTerms = { model, ratio, mortgageTreatment: 'EQUAL' };
  if ((model === 'FIXED' || model === 'RING_FENCE') && !ratio) terms.ratio = Object.fromEntries(owners.map((o) => [o.id, Math.round(10_000 / owners.length)]));
  return currentShares(owners, contributions, terms, { pricePennies: price, mortgagePennies: mortgage }, price, mortgage).map((r) => ({ party: r.name, shareBp: r.shareBp }));
}

/** Contributions more than ten per cent apart: equal ownership would not reflect them. */
export function unequal(cs: ContributionInput[]): boolean {
  if (cs.length < 2) return false;
  const total = cs.reduce((a, c) => a + c.pennies, 0);
  if (!total) return false;
  const shares = cs.map((c) => c.pennies / total);
  return Math.max(...shares) - Math.min(...shares) > 0.1;
}

/** "60/40", the shares as the deed states them. */
export const sharesText = (shares: Array<{ party: string; shareBp: number }>): string => shares.map((x) => `${x.party} ${(x.shareBp / 100).toFixed(x.shareBp % 100 ? 2 : 0)}%`).join(', ');
