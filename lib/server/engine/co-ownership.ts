/**
 * Co-owners' money (docs/co-ownership.md): who put what in, what each owns, and what each is paid on a sale or a
 * buy-out, under the declaration of trust's model. Pure, in whole pennies; every rounding goes to the last owner so
 * the parts always add up to the whole, and every stage of a calculation is kept for the audit trail.
 *
 * Models (what UK declarations of trust use):
 * - FIXED: agreed percentages, never moving.
 * - RING_FENCE: each owner's ring-fenced money (usually the deposit) comes back first; the rest is split in a set ratio.
 * - CONTRIBUTION: shares in proportion to what each contributed to the total cost, the mortgage counted by the agreed
 *   treatment (equally, in a ratio, or by who pays it).
 * - FLOATING: the five-stage formula: growth (or fall) follows the money that bought each part, owners' own cash pro
 *   rata, the mortgage-funded part by mortgage payments; sale costs pro rata to the result.
 * A shortfall (negative equity) is never capped at zero: the lender can pursue either borrower, and the deed decides
 * how the owners settle it between themselves.
 */

export type TrustModel = 'FIXED' | 'RING_FENCE' | 'CONTRIBUTION' | 'FLOATING';
export type MortgageTreatment = 'EQUAL' | 'RATIO' | 'BY_PAYMENTS';
export type ContributionType = 'DEPOSIT' | 'SDLT' | 'LEGAL_FEES' | 'OTHER_COST' | 'IMPROVEMENT' | 'CAPITAL_REPAYMENT' | 'MORTGAGE_PAYMENT';

export interface Owner { id: string; name: string }
export interface Contribution { ownerId: string; type: ContributionType; pennies: number; date: string; /** A gift through this owner (a donor's money counts as the owner's contribution under the deed). */ donor?: string | null }
export interface TrustTerms {
  model: TrustModel;
  /** FIXED: each owner's percentage (basis points of 10,000). RING_FENCE: the ratio the rest is split in. */
  ratio?: Record<string, number>;
  mortgageTreatment?: MortgageTreatment;
  /** RATIO treatment: each owner's share of the mortgage, in basis points. */
  mortgageRatio?: Record<string, number>;
  /** Whether capital repayments and improvements after purchase count as contributions. */
  countCapitalRepayments?: boolean;
  /** Improvements below this are ignored (pennies). */
  improvementThreshold?: number;
  /** RING_FENCE: which contribution types are ring-fenced (default: deposits). */
  ringFenced?: ContributionType[];
}
export interface Purchase { pricePennies: number; mortgagePennies: number }
export interface Disposal { valuePennies: number; costsPennies: number; redemptionPennies: number }

export interface OwnerResult { ownerId: string; name: string; pennies: number; shareBp: number }
export interface Calculation { model: TrustModel; result: OwnerResult[]; netPennies: number; stages: Array<{ label: string; values: Record<string, number> }>; warnings: string[] }

const BP = 10_000;
const PURCHASE_TYPES: ContributionType[] = ['DEPOSIT', 'SDLT', 'LEGAL_FEES', 'OTHER_COST'];

/** Split `total` across owners by `weights`, in whole pennies, the remainder to the last owner so the parts sum exactly. */
export function apportion(total: number, owners: Owner[], weights: Record<string, number>): Record<string, number> {
  const sum = owners.reduce((a, o) => a + (weights[o.id] ?? 0), 0);
  const out: Record<string, number> = {};
  if (!owners.length) return out;
  if (sum === 0) { owners.forEach((o, i) => (out[o.id] = i === owners.length - 1 ? total - Math.trunc(total / owners.length) * (owners.length - 1) : Math.trunc(total / owners.length))); return out; }
  let given = 0;
  owners.forEach((o, i) => {
    if (i === owners.length - 1) out[o.id] = total - given;
    else { const v = Math.round((total * (weights[o.id] ?? 0)) / sum); out[o.id] = v; given += v; }
  });
  return out;
}

/** Each owner's own cash counted under the deed: purchase money, plus (if the deed says) capital repaid and improvements. */
export function cashOf(owners: Owner[], contributions: Contribution[], terms: TrustTerms): Record<string, number> {
  const out = Object.fromEntries(owners.map((o) => [o.id, 0])) as Record<string, number>;
  for (const c of contributions) {
    if (!(c.ownerId in out)) continue;
    if (PURCHASE_TYPES.includes(c.type)) out[c.ownerId] += c.pennies;
    else if (c.type === 'IMPROVEMENT' && terms.countCapitalRepayments !== false && c.pennies >= (terms.improvementThreshold ?? 0)) out[c.ownerId] += c.pennies;
    else if (c.type === 'CAPITAL_REPAYMENT' && terms.countCapitalRepayments) out[c.ownerId] += c.pennies;
  }
  return out;
}

/** Each owner's part of the mortgage, as weights: equally, in the agreed ratio, or by what each has actually paid. */
export function mortgageWeights(owners: Owner[], contributions: Contribution[], terms: TrustTerms): Record<string, number> {
  const t = terms.mortgageTreatment ?? 'EQUAL';
  if (t === 'RATIO' && terms.mortgageRatio) return { ...terms.mortgageRatio };
  if (t === 'BY_PAYMENTS') {
    const paid = Object.fromEntries(owners.map((o) => [o.id, 0])) as Record<string, number>;
    for (const c of contributions) if ((c.type === 'MORTGAGE_PAYMENT' || c.type === 'CAPITAL_REPAYMENT') && c.ownerId in paid) paid[c.ownerId] += c.pennies;
    if (Object.values(paid).some((v) => v > 0)) return paid;
  }
  return Object.fromEntries(owners.map((o) => [o.id, 1]));
}

const shares = (owners: Owner[], amounts: Record<string, number>): Record<string, number> => {
  const total = owners.reduce((a, o) => a + amounts[o.id], 0);
  return total > 0 ? apportion(BP, owners, amounts) : apportion(BP, owners, Object.fromEntries(owners.map((o) => [o.id, 1])));
};

/** What each owner receives (negative: owes) from a sale or valuation under the deed's model. */
export function entitlements(owners: Owner[], contributions: Contribution[], terms: TrustTerms, purchase: Purchase, d: Disposal): Calculation {
  const warnings: string[] = [];
  const stages: Calculation['stages'] = [];
  const net = d.valuePennies - d.costsPennies - d.redemptionPennies;
  const result = (amounts: Record<string, number>): OwnerResult[] => {
    const sh = shares(owners, Object.fromEntries(owners.map((o) => [o.id, Math.max(0, amounts[o.id])])));
    return owners.map((o) => ({ ownerId: o.id, name: o.name, pennies: amounts[o.id], shareBp: sh[o.id] }));
  };
  if (net < 0) warnings.push('Negative equity: the sale does not clear the mortgage. Between the owners the deed decides who bears it; the lender can pursue either borrower for all of it.');

  if (terms.model === 'FIXED') {
    const ratio = terms.ratio ?? Object.fromEntries(owners.map((o) => [o.id, 1]));
    const out = apportion(net, owners, ratio);
    stages.push({ label: 'Net proceeds split in the fixed shares', values: out });
    return { model: 'FIXED', result: result(out), netPennies: net, stages, warnings };
  }

  const cash = cashOf(owners, contributions, terms);
  stages.push({ label: "Each owner's own money counted under the deed", values: cash });

  if (terms.model === 'RING_FENCE') {
    const types = terms.ringFenced ?? ['DEPOSIT'];
    const ring = Object.fromEntries(owners.map((o) => [o.id, contributions.filter((c) => c.ownerId === o.id && types.includes(c.type)).reduce((a, c) => a + c.pennies, 0)])) as Record<string, number>;
    const ringTotal = Object.values(ring).reduce((a, b) => a + b, 0);
    const ratio = terms.ratio ?? Object.fromEntries(owners.map((o) => [o.id, 1]));
    let out: Record<string, number>;
    if (net >= ringTotal) {
      const rest = apportion(net - ringTotal, owners, ratio);
      out = Object.fromEntries(owners.map((o) => [o.id, ring[o.id] + rest[o.id]]));
      stages.push({ label: 'Ring-fenced money back first', values: ring }, { label: 'The rest in the agreed ratio', values: rest });
    } else {
      // Not enough to return every ring-fenced sum: what there is goes back pro rata to them (a shortfall, pro rata too).
      out = apportion(net, owners, ringTotal > 0 ? ring : ratio);
      warnings.push('The proceeds do not return every ring-fenced sum in full: they are shared in proportion to the ring-fenced amounts.');
      stages.push({ label: 'Proceeds short of the ring-fenced money, shared pro rata to it', values: out });
    }
    return { model: 'RING_FENCE', result: result(out), netPennies: net, stages, warnings };
  }

  const mw = mortgageWeights(owners, contributions, terms);
  const totalCost = owners.reduce((a, o) => a + cash[o.id], 0) + purchase.mortgagePennies;
  if (totalCost <= 0) { warnings.push('No contributions recorded: shared equally.'); const out = apportion(net, owners, {}); return { model: terms.model, result: result(out), netPennies: net, stages, warnings }; }

  if (terms.model === 'CONTRIBUTION') {
    const mortgagePart = apportion(purchase.mortgagePennies, owners, mw);
    const contributed = Object.fromEntries(owners.map((o) => [o.id, cash[o.id] + mortgagePart[o.id]])) as Record<string, number>;
    stages.push({ label: "Each owner's part of the mortgage", values: mortgagePart }, { label: 'Total contributed', values: contributed });
    const out = apportion(net, owners, contributed);
    stages.push({ label: 'Net proceeds in proportion to contributions', values: out });
    return { model: 'CONTRIBUTION', result: result(out), netPennies: net, stages, warnings };
  }

  // FLOATING: the five stages.
  const own = Object.fromEntries(owners.map((o) => [o.id, Math.round((d.valuePennies * cash[o.id]) / totalCost)])) as Record<string, number>;
  stages.push({ label: "Stage 1: the value bought with each owner's own money", values: own });
  const mortgageEquity = Math.round((d.valuePennies * purchase.mortgagePennies) / totalCost) - d.redemptionPennies;
  const mort = apportion(mortgageEquity, owners, mw);
  stages.push({ label: 'Stage 2: the mortgage-funded part, less the mortgage, by mortgage payments', values: mort });
  const gross = Object.fromEntries(owners.map((o) => [o.id, own[o.id] + mort[o.id]])) as Record<string, number>;
  stages.push({ label: 'Stage 3: before sale costs', values: gross });
  const grossTotal = Object.values(gross).reduce((a, b) => a + b, 0);
  const costs = grossTotal > 0 ? apportion(d.costsPennies, owners, Object.fromEntries(owners.map((o) => [o.id, Math.max(0, gross[o.id])]))) : apportion(d.costsPennies, owners, mw);
  stages.push({ label: 'Stage 4: sale costs pro rata', values: costs });
  const out = Object.fromEntries(owners.map((o) => [o.id, gross[o.id] - costs[o.id]])) as Record<string, number>;
  // Rounding in stages 1-2 can leave a penny over or under the net: it goes to the last owner so the parts add up.
  const drift = net - Object.values(out).reduce((a, b) => a + b, 0);
  if (drift && owners.length) out[owners[owners.length - 1].id] += drift;
  stages.push({ label: 'Stage 5: each owner receives', values: out });
  return { model: 'FLOATING', result: result(out), netPennies: net, stages, warnings };
}

/** Today's shares under the deed: the same calculation at an estimated value and the latest mortgage balance (no sale costs). */
export function currentShares(owners: Owner[], contributions: Contribution[], terms: TrustTerms, purchase: Purchase, valuePennies: number, balancePennies: number): OwnerResult[] {
  return entitlements(owners, contributions, terms, purchase, { valuePennies, costsPennies: 0, redemptionPennies: balancePennies }).result;
}

/**
 * A buy-out (transfer of equity): what the leaving owners are paid under the deed at the agreed value, and the SDLT
 * consideration for the staying owners: the cash, plus the part of the mortgage they take over (FA 2003 Sch 4 para 8).
 */
export function buyOut(owners: Owner[], leaving: string[], contributions: Contribution[], terms: TrustTerms, purchase: Purchase, agreedValuePennies: number, balancePennies: number, costsPennies = 0): { payouts: OwnerResult[]; cashPennies: number; debtAssumedPennies: number; sdltConsiderationPennies: number; flags: string[] } {
  const calc = entitlements(owners, contributions, terms, purchase, { valuePennies: agreedValuePennies, costsPennies, redemptionPennies: balancePennies });
  const payouts = calc.result.filter((r) => leaving.includes(r.ownerId));
  const cash = payouts.reduce((a, r) => a + r.pennies, 0);
  // The staying owners take on the leaving owners' part of the joint debt: in proportion to the leaving owners' shares.
  const leavingBp = payouts.reduce((a, r) => a + r.shareBp, 0);
  const debt = Math.round((balancePennies * leavingBp) / BP);
  const flags = ['Divorce, dissolution or a court order: SDLT exempt (FA 2003 Sch 3 para 3); check before filing.', 'No cash and no debt taken over: a gift, no SDLT.', 'The higher rates may not apply where a spouse or an existing owner increases their share: check the exceptions.'];
  return { payouts, cashPennies: cash, debtAssumedPennies: debt, sdltConsiderationPennies: Math.max(0, cash) + debt, flags: cash + debt >= 4_000_000 ? ['An SDLT return is needed (£40,000 or more).', ...flags] : flags };
}
