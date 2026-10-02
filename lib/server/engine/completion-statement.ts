/**
 * The completion statement, drafted from the register (Document Review Engine): every
 * figure on it is a fact the file states, cited to its document and page, or a line the
 * conveyancer must fill. Arithmetic is the engine's; nothing is estimated. The draft is
 * filed as a document and checked like every other draft, so the balance and the
 * apportionments (which are computed, not read) are allowed and the source figures cite.
 */
import { chargeableConsideration } from './sdlt-facts';
import { canon, type RegisterFact } from './draft-check';
import type { MatterState } from './types';
import { computeSdlt, sdltLabel } from './sdlt';

export interface StatementLine { label: string; pennies: number | null; sign: 1 | -1 | 0; factId: string | null; note?: string }
export interface CompletionStatement { title: string; lines: StatementLine[]; balancePennies: number | null; toConfirm: string[]; text: string; allowed: string[] }

const pounds = (p: number) => `£${(Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money = (p: number, sign: 1 | -1 | 0) => (sign < 0 ? `(${pounds(p)})` : pounds(p));

function factOf(facts: RegisterFact[], ...keys: RegExp[]): RegisterFact | null {
  for (const re of keys) { const f = facts.find((x) => re.test(x.key) && /^\d+$/.test(x.value.trim())); if (f) return f; }
  return null;
}
const textFact = (facts: RegisterFact[], re: RegExp) => facts.find((x) => re.test(x.key)) ?? null;

/** Days from `from` (inclusive) to `to` (inclusive), or null when either date is missing or malformed. */
export function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = new Date(from); const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
}

/** "1 April 2026 to 31 March 2027" → the two ISO dates, when both can be read. */
export function parsePeriod(s: string | null | undefined): { from: string; to: string } | null {
  if (!s) return null;
  const m = s.match(/(\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\s*(?:to|-|–|until)\s*(\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (!m) return null;
  const from = canon.date(m[1]); const to = canon.date(m[2]);
  return from && to ? { from, to } : null;
}

/**
 * Build the statement. Buyer side: price less deposit less advance, plus apportionments and
 * the fees to confirm, balance from the client. Seller side: price less redemption and
 * the fees to confirm, balance to the client.
 */
export function buildCompletionStatement(input: { state: MatterState; side: 'buyer' | 'seller' | 'owner'; register: RegisterFact[]; record: { propertyAddress: string | null; purchasePricePennies: number | null; buyerNames: string[]; sellerNames: string[] } }): CompletionStatement {
  const { state, side, register, record } = input;
  const lines: StatementLine[] = [];
  const toConfirm: string[] = [];
  const allowed: string[] = [];
  const completionDate = state.exchange.completionDate ?? null;

  // A remortgage or a transfer of equity (completion.md 5.5): the new advance less what it pays off, the surplus to the client or the top-up from them.
  if (side === 'owner') return ownerStatement(state, register, record.propertyAddress, record.buyerNames, completionDate ?? state.targetCompletionDate ?? null);

  const priceFact = factOf(register, /^contract\.price_pennies$/, /^offer\.purchase_price_pennies$/);
  const pricePennies = priceFact ? Number(priceFact.value) : record.purchasePricePennies ?? state.purchasePricePennies ?? null;
  if (pricePennies == null) toConfirm.push('Purchase price: not on the file');
  const sale = side === 'seller';
  lines.push({ label: sale ? 'Sale price' : 'Purchase price', pennies: pricePennies, sign: 1, factId: priceFact?.id ?? null });

  const chattels = factOf(register, /^contract\.chattels_price_pennies$/);
  if (chattels) lines.push({ label: 'Chattels', pennies: Number(chattels.value), sign: 1, factId: chattels.id });

  if (!sale) {
    if (state.reservationFeePennies) { lines.push({ label: "Less reservation fee paid to the developer", pennies: state.reservationFeePennies, sign: -1, factId: null }); allowed.push(pounds(state.reservationFeePennies)); }
    const deposit = factOf(register, /^contract\.deposit_pennies$/);
    if (deposit) lines.push({ label: 'Less deposit paid on exchange', pennies: Number(deposit.value), sign: -1, factId: deposit.id });
    else if (state.deposit.received) toConfirm.push('Deposit paid on exchange: amount not on the file');
    if (state.hasLender) {
      const advance = factOf(register, /^offer\.amount_pennies$/);
      if (advance) lines.push({ label: `Less mortgage advance${state.mortgage.facts?.lender ? ` (${state.mortgage.facts.lender})` : ''}`, pennies: Number(advance.value), sign: -1, factId: advance.id });
      else toConfirm.push('Mortgage advance: amount not on the file');
    }
  } else {
    if (state.redemption.status !== 'not_required') {
      if (state.redemption.redemptionPennies != null) { lines.push({ label: `Less redemption of mortgage${state.redemption.lender ? ` (${state.redemption.lender})` : ''}`, pennies: state.redemption.redemptionPennies, sign: -1, factId: null, note: state.redemption.validUntil ? `figure valid until ${state.redemption.validUntil}` : undefined }); allowed.push(pounds(state.redemption.redemptionPennies)); }
      else toConfirm.push('Redemption figure: not yet received');
    }
    // Every other charge on the title comes off from the proceeds too (charges.ts).
    for (const c of state.otherCharges ?? []) {
      if (c.redemptionPennies != null) { lines.push({ label: `Less redemption of charge (${c.chargee})`, pennies: c.redemptionPennies, sign: -1, factId: null, note: c.validUntil ? `figure valid until ${c.validUntil}` : undefined }); allowed.push(pounds(c.redemptionPennies)); }
      else toConfirm.push(`Redemption figure for the charge in favour of ${c.chargee}: not yet received`);
    }
    toConfirm.push("Estate agent's commission: from the agent's invoice");
    // The deposit we hold as stakeholder is released to the seller on completion (completion.md 4.16): it is part of the balance.
    const held = textFact(register, /^contract\.deposit_holder$/);
    const dep = factOf(register, /^contract\.deposit_pennies$/);
    if (dep && held && /stakeholder/i.test(held.value)) lines.push({ label: 'Of which the deposit we hold as stakeholder, released on completion', pennies: Number(dep.value), sign: 0, factId: dep.id });
  }

  // SDLT on the declared basis: an estimate the person filing checks, never the figure itself.
  if (!sale && side === 'buyer' && pricePennies != null && pricePennies > 0) {
    const basis = { ...(state.sdltBasis ?? { firstTimeBuyer: false, additionalProperty: false, nonUkResident: false }), company: state.shapes?.includes('company_buyer') ?? false };
    const est = computeSdlt(chargeableConsideration(state) ?? pricePennies, basis);
    lines.push({ label: `${basis.wales ? 'Land Transaction Tax' : 'Stamp Duty Land Tax'} (estimate, ${est.scheme}${state.sdltBasis ? '' : ', no basis declared'})`, pennies: est.totalPennies, sign: 1, factId: priceFact?.id ?? null, note: `${sdltLabel(basis)} basis` });
    allowed.push(pounds(est.totalPennies));
    toConfirm.push(`SDLT: ${pounds(est.totalPennies)} is the estimate on the ${sdltLabel(basis)} basis; confirm against HMRC's calculator before the return.`);
  }
  // Leasehold apportionments: the seller has paid the year's ground rent and service charge; the buyer refunds from completion to the period end.
  const period = parsePeriod(textFact(register, /^pack\.service_charge_period$/)?.value);
  for (const [label, re] of [['service charge', /^pack\.service_charge_pennies_pa$/], ['ground rent', /^(pack|lease)\.ground_rent_pennies_pa$/]] as const) {
    const f = factOf(register, re);
    if (!f) continue;
    const pa = Number(f.value);
    if (period && completionDate && completionDate >= period.from && completionDate <= period.to) {
      const total = daysBetween(period.from, period.to)!;
      const remaining = daysBetween(completionDate, period.to)!;
      const share = Math.round((pa * remaining) / total);
      lines.push({ label: `Apportionment of ${label} (${remaining} of ${total} days, ${pounds(pa)} a year)`, pennies: share, sign: sale ? -1 : 1, factId: f.id, note: `${period.from} to ${period.to}` });
      allowed.push(pounds(share));
    } else {
      toConfirm.push(`Apportionment of ${label} (${pounds(pa)} a year): completion date or charge period not on the file`);
      lines.push({ label: `Apportionment of ${label}`, pennies: null, sign: sale ? -1 : 1, factId: f.id });
    }
  }

  // Retentions agreed on an issue (property.md 9.2, 6.3, 7.5): on a sale the buyer's solicitor holds them back; on a purchase they are held from the seller.
  for (const i of Object.values(state.issues)) {
    if (i.status !== 'resolved' || i.resolution !== 'retention_agreed' || !i.costPennies) continue;
    lines.push({ label: sale ? `Less retention held by the buyer's solicitor (${i.title.slice(0, 50)})` : `Of which held back as a retention (${i.title.slice(0, 50)})`, pennies: i.costPennies, sign: sale ? -1 : 0, factId: null, note: 'released under the contract condition' });
    allowed.push(pounds(i.costPennies));
  }
  // Indemnity premiums (property.md 9.1): on the statement of whoever pays them.
  for (const i of Object.values(state.issues)) {
    if (i.status !== 'resolved' || i.resolution !== 'indemnity_policy' || !i.costPennies) continue;
    const payer = (i as { paidBy?: string | null }).paidBy;
    if ((sale && payer === 'seller') || (!sale && payer === 'buyer')) { lines.push({ label: `${sale ? 'Less indemnity' : 'Indemnity'} policy premium (${i.title.slice(0, 50)})`, pennies: i.costPennies, sign: sale ? -1 : 1, factId: null }); allowed.push(pounds(i.costPennies)); }
  }
  // Leasehold arrears are cleared from the sale price on completion (property.md 7.4).
  const arrears = (state.managementPack?.facts as { arrearsPennies?: number | null } | null)?.arrearsPennies;
  if (sale && arrears) { lines.push({ label: 'Less service charge / ground rent arrears, paid to the landlord', pennies: arrears, sign: -1, factId: null }); allowed.push(pounds(arrears)); }
  // Lines only the firm can fill.
  const sdltEstimated = lines.some((l) => l.label.startsWith('Stamp Duty Land Tax ('));
  for (const l of sale ? ['Our fees', 'Disbursements', 'Land Registry fee for official copies'] : ['Our fees', ...(sdltEstimated ? [] : ['Stamp Duty Land Tax']), 'Land Registry registration fee', 'Searches and disbursements', 'Bank transfer fee']) {
    lines.push({ label: l, pennies: null, sign: sale ? -1 : 1, factId: null });
  }

  const known = lines.filter((l) => l.pennies != null && l.sign !== 0);
  const balancePennies = pricePennies == null ? null : known.reduce((acc, l) => acc + l.sign * (l.pennies as number), 0);
  if (balancePennies != null) allowed.push(pounds(balancePennies));

  const title = `COMPLETION STATEMENT (DRAFT — requires conveyancer approval before sending)`;
  const width = 52;
  const row = (label: string, value: string) => `${label.padEnd(width)}${value.padStart(16)}`;
  const text = [
    title,
    '',
    `Property: ${record.propertyAddress ?? '[CONVEYANCER TO CONFIRM]'}`,
    `${sale ? 'Seller' : 'Buyer'}: ${(sale ? record.sellerNames : record.buyerNames).join(' and ') || '[CONVEYANCER TO CONFIRM]'}`,
    `Completion date: ${completionDate ?? '[CONVEYANCER TO CONFIRM]'}`,
    '',
    sale ? 'SALE' : 'PURCHASE',
    ...lines.map((l) => row(l.label, l.pennies == null ? '[TO CONFIRM]' : money(l.pennies, l.sign)) + (l.note ? `  ${l.note}` : '')),
    '',
    row(sale ? 'BALANCE DUE TO YOU (before the items to confirm)' : 'BALANCE REQUIRED FROM YOU (before the items to confirm)', balancePennies == null ? '[TO CONFIRM]' : pounds(balancePennies)),
    '',
    ...(toConfirm.length ? ['POINTS FOR THE CONVEYANCER TO CONFIRM', ...toConfirm.map((t) => `- ${t}`), ''] : []),
    'Every figure above is taken from a document on the file or computed from one; the sources are listed below. The balance changes once the items to confirm are filled in.',
  ].join('\n');
  return { title, lines, balancePennies, toConfirm, text, allowed };
}

function ownerStatement(state: MatterState, register: RegisterFact[], address: string | null, owners: string[], completionDate: string | null): CompletionStatement {
  const lines: StatementLine[] = [];
  const toConfirm: string[] = [];
  const allowed: string[] = [];
  const advance = factOf(register, /^offer\.amount_pennies$/);
  const advancePennies = advance ? Number(advance.value) : (state.mortgage.facts as { amountPennies?: number } | null)?.amountPennies ?? null;
  if (state.hasLender) {
    if (advancePennies != null) lines.push({ label: `New mortgage advance${state.mortgage.facts?.lender ? ` (${state.mortgage.facts.lender})` : ''}`, pennies: advancePennies, sign: 1, factId: advance?.id ?? null });
    else toConfirm.push('New mortgage advance: amount not on the file');
  }
  if (state.considerationPennies) lines.push({ label: 'Paid by the incoming owner', pennies: state.considerationPennies, sign: 1, factId: null });
  if (state.redemption.status !== 'not_required') {
    if (state.redemption.redemptionPennies != null) { lines.push({ label: `Less redemption of the existing mortgage${state.redemption.lender ? ` (${state.redemption.lender})` : ''}`, pennies: state.redemption.redemptionPennies, sign: -1, factId: null }); allowed.push(pounds(state.redemption.redemptionPennies)); }
    else toConfirm.push('Redemption figure: not yet received');
  }
  for (const c of state.otherCharges ?? []) {
    if (c.redemptionPennies != null) lines.push({ label: `Less redemption of charge (${c.chargee})`, pennies: c.redemptionPennies, sign: -1, factId: null });
    else toConfirm.push(`Redemption figure for the charge in favour of ${c.chargee}: not yet received`);
  }
  for (const l of ['Our fees', 'Land Registry fee', 'Lender\'s fees deducted from the advance']) lines.push({ label: `Less ${l.toLowerCase()}`, pennies: null, sign: -1, factId: null });
  const known = lines.filter((l) => l.pennies != null && l.sign !== 0);
  const balancePennies = known.length ? known.reduce((acc, l) => acc + l.sign * (l.pennies as number), 0) : null;
  if (balancePennies != null) allowed.push(pounds(Math.abs(balancePennies)));
  const title = 'STATEMENT OF ACCOUNT (DRAFT — requires conveyancer approval before sending)';
  const row = (label: string, value: string) => `${label.padEnd(52)}${value.padStart(16)}`;
  const text = [
    title, '', `Property: ${address ?? '[CONVEYANCER TO CONFIRM]'}`, `Owner: ${owners.join(' and ') || '[CONVEYANCER TO CONFIRM]'}`, `Completion date: ${completionDate ?? '[CONVEYANCER TO CONFIRM]'}`, '',
    ...lines.map((l) => row(l.label, l.pennies == null ? '[TO CONFIRM]' : money(l.pennies, l.sign))), '',
    row(balancePennies != null && balancePennies < 0 ? 'BALANCE REQUIRED FROM YOU (before the items to confirm)' : 'BALANCE DUE TO YOU (before the items to confirm)', balancePennies == null ? '[TO CONFIRM]' : pounds(balancePennies)), '',
    ...(toConfirm.length ? ['POINTS FOR THE CONVEYANCER TO CONFIRM', ...toConfirm.map((t) => `- ${t}`), ''] : []),
  ].join('\n');
  return { title, lines, balancePennies, toConfirm, text, allowed };
}
