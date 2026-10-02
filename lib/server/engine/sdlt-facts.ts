/**
 * The SDLT basis worked out from the buyers' facts, not ticked (docs/eventualities/tax.md; theme F).
 *
 * The questions are the ones the tests turn on, asked of the buyers as a group because every rule is "any buyer"
 * or "every buyer": first-time buyer relief needs every buyer never to have owned a home; the higher rates follow
 * if any buyer (or their spouse) owns another dwelling at the end of the completion day, unless the purchase
 * replaces the main residence and that sale completes first; the non-resident surcharge follows if any buyer was
 * outside the UK for most of the last year. Each derived answer carries the fact it came from, and a shape that
 * contradicts the answers is said out loud. On a sale the facts are the two CGT questions: a flag, never advice.
 */
import type { SdltBasis } from './sdlt';
import type { MatterState } from './types';

export interface SdltFacts {
  /** The property is in Wales (LTT). */
  wales?: boolean;
  /** It will be the buyers' only or main residence. */
  mainResidence?: boolean;
  /** Any buyer has ever owned a home (any share, anywhere in the world, inherited included). */
  anyEverOwned?: boolean;
  /** At the end of the completion day any buyer, or their spouse, will own another dwelling worth £40,000 or more. */
  anyOwnsOther?: boolean;
  /** A buyer is selling their only or main residence. */
  replacing?: boolean;
  /** That sale completes on or before this purchase (or completed within the last three years). */
  replacingFirst?: boolean;
  /** Any buyer spent fewer than 183 days in the UK in the 12 months before completion. */
  anyNonResident?: boolean;
  /** Part of the property is genuinely non-residential. */
  mixedUse?: boolean;
  /** Transfer of equity: the mortgage debt the incoming owner takes on (chargeable consideration). */
  debtAssumedPennies?: number | null;
  /** Shared ownership: the buyer elects to pay on the full market value now (FA 2003 Sch 9 para 2), rather than on each share as bought. */
  soMarketValue?: boolean;
  soMarketValuePennies?: number | null;
  /** The other holdings a buyer (or their spouse) has, each tested on its own (tax.md A5-A13, A22). When given, they decide `anyOwnsOther`. */
  otherHoldings?: OtherHolding[] | null;
  /** A spouse or civil partner owns a dwelling (B5); switched off if they are separated (A4). */
  spouseOwns?: boolean;
  spouseSeparated?: boolean;
  /** How many dwellings this purchase includes (A19), and an annexe worth under a third of the whole (A20). */
  dwellingsInPurchase?: number | null;
  annexeUnderThird?: boolean;
  /** A Crown employee or serving abroad in the forces: treated as UK resident (C5). */
  crownEmployee?: boolean;
  /** A company buyer's relief from the 17% rate (D3). */
  companyRelief?: 'rental' | 'development' | 'trading' | 'employee' | null;
  /** Who is buying, when not individuals (D4-D7). */
  buyerType?: 'discretionary_trust' | 'bare_trust' | 'personal_representatives' | 'partnership' | 'charity' | null;
  /** VAT on the price (E4), the value of a part-exchange (E5). */
  vatPennies?: number | null;
  partExchangePennies?: number | null;
  /** The buyer says the property is not suitable as a dwelling (E9): a claim for a person, never the default. */
  uninhabitableClaim?: boolean;
  /** The grant of a new lease (F1): the rent and the term, for the 1% on the rent's net present value. */
  newLeaseRentPennies?: number | null;
  newLeaseTermYears?: number | null;
  /** A statutory lease extension of the buyer's own home (F3). */
  statutoryExtension?: boolean;
  /** A transfer between spouses or civil partners (F7). */
  betweenSpouses?: boolean;
  /** Part of the land is in Wales (H8): its share of the consideration, in per cent. */
  welshPercent?: number | null;
  /** The sheet's single answer about the other home (when there is one): what it is. */
  otherHomeIs?: OtherHolding['type'] | 'under_40k' | null;
}

/** One other property a buyer or their spouse holds (tax.md A5-A13). */
export interface OtherHolding {
  type: 'dwelling' | 'share' | 'abroad' | 'inherited_share' | 'childs' | 'commercial' | 'caravan' | 'short_lease' | 'partnership_or_trust';
  valuePennies?: number | null;
  /** The buyer's share (per cent), for a share. */
  sharePercent?: number | null;
  /** When an inherited share came (ISO), and whether the buyer and spouse have held 50% or less throughout. */
  inheritedOn?: string | null;
  combinedUnderHalf?: boolean;
  unexpiredYears?: number | null;
}

/** Whether one holding makes the purchase a higher-rates transaction, and why (FA 2003 Sch 4ZA). */
export function holdingCounts(h: OtherHolding, effectiveDate: Date): { counts: boolean; why: string } {
  const value = h.valuePennies ?? null;
  const worth = value == null ? null : h.type === 'share' && h.sharePercent != null ? Math.round(value * h.sharePercent / 100) : value;
  if (h.type === 'commercial') return { counts: false, why: 'commercial or non-residential property does not count' };
  if (h.type === 'caravan') return { counts: false, why: 'a caravan, mobile home or houseboat does not count' };
  if (h.type === 'short_lease' && (h.unexpiredYears ?? 0) <= 21) return { counts: false, why: 'a lease with 21 years or less left is not a major interest' };
  if (worth != null && worth < 4_000_000) return { counts: false, why: `worth under £40,000 (£${(worth / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}${h.type === 'share' ? ' for the share' : ''})` };
  if (h.type === 'inherited_share' && h.inheritedOn && h.combinedUnderHalf) {
    const end = new Date(h.inheritedOn); end.setUTCFullYear(end.getUTCFullYear() + 3);
    if (effectiveDate < end) return { counts: false, why: `an inherited share of 50% or less, inherited within three years (until ${end.toISOString().slice(0, 10)})` };
    return { counts: true, why: 'an inherited share now held for more than three years' };
  }
  if (h.type === 'abroad') return { counts: true, why: 'a dwelling abroad counts like one in the UK' };
  if (h.type === 'childs') return { counts: true, why: "a dwelling held for a child under 18 counts as the parent's" };
  if (h.type === 'partnership_or_trust') return { counts: true, why: 'an interest through a partnership, a life interest or a bare trust counts as the buyer\'s own' };
  if (h.type === 'share') return { counts: true, why: 'a share of a dwelling worth £40,000 or more counts' };
  return { counts: true, why: 'another dwelling worth £40,000 or more' };
}

export interface CgtFacts {
  /** The client's only or main home for the whole time they owned it. */
  mainResidenceThroughout?: boolean;
  /** UK resident for tax. */
  ukResident?: boolean;
  /** Why private residence relief may be partial (tax.md G3). */
  absencesOrLet?: boolean;
  businessUse?: boolean;
  groundsOverHalfHectare?: boolean;
  anotherResidence?: boolean;
  /** Part of the garden or a plot, or land kept after the house was sold (G4). */
  partOfGarden?: boolean;
  /** The seller is a company (G5), or personal representatives / trustees (G6). */
  sellerType?: 'company' | 'personal_representatives' | 'trustees' | null;
  /** A gift, or a sale to family below value (F8): CGT at market value. */
  giftToConnected?: boolean;
  /** Money the client asks us to hold back for the tax (G7). */
  taxRetentionPennies?: number | null;
}

export interface DerivedBasis { basis: SdltBasis & { wales?: boolean }; reasons: string[]; contradictions: string[]; refundDiary: boolean }

/** The basis from the facts, with the fact behind each answer. */
export function deriveSdltBasis(f: SdltFacts & { effectiveDate?: string | null }, s: Pick<MatterState, 'shapes' | 'relatedMatter'>): DerivedBasis {
  const company = s.shapes?.includes('company_buyer') ?? false;
  const reasons: string[] = [];
  const contradictions: string[] = [];
  // A linked sale of the client's own home completes no later than this purchase: the machine holds it that way.
  const chainSale = s.relatedMatter?.relation === 'sale';
  // The finer facts decide the plain answer when they are given (tax.md A4-A13, A22, B5).
  const when = f.effectiveDate ? new Date(f.effectiveDate) : new Date();
  // The sheet's one answer about the other home becomes a holding of its own.
  if (!f.otherHoldings && f.otherHomeIs && f.anyOwnsOther) f = { ...f, otherHoldings: [f.otherHomeIs === 'under_40k' ? { type: 'dwelling', valuePennies: 3_999_900 } : f.otherHomeIs === 'inherited_share' ? { type: 'inherited_share', inheritedOn: new Date(when.getTime() - 365 * 86_400_000).toISOString().slice(0, 10), combinedUnderHalf: true } : f.otherHomeIs === 'short_lease' ? { type: 'short_lease', unexpiredYears: 21 } : { type: f.otherHomeIs }] };
  const tested = (f.otherHoldings ?? []).map((h) => ({ h, ...holdingCounts(h, when) }));
  for (const t of tested) reasons.push(`Other holding (${t.h.type.replace(/_/g, ' ')}): ${t.counts ? 'counts' : 'ignored'}: ${t.why}.`);
  const spouseCounts = !!f.spouseOwns && !f.spouseSeparated;
  if (f.spouseOwns) reasons.push(f.spouseSeparated ? 'The spouse owns a dwelling but they are separated (court order, deed, or permanently): it does not count.' : "The buyer's spouse or civil partner owns a dwelling: it counts as the buyer's (and first-time buyers' relief is lost).");
  if (f.otherHoldings || f.spouseOwns !== undefined) f = { ...f, anyOwnsOther: tested.some((t) => t.counts) || spouseCounts || (!f.otherHoldings && !!f.anyOwnsOther) };
  const several = (f.dwellingsInPurchase ?? 1) > 1 && !f.annexeUnderThird;
  if ((f.dwellingsInPurchase ?? 1) > 1) reasons.push(f.annexeUnderThird ? 'An annexe within the grounds worth under a third of the whole: no higher rates on that account.' : `${f.dwellingsInPurchase} dwellings in one purchase: the higher rates apply${(f.dwellingsInPurchase ?? 0) >= 6 ? ', or the non-residential rates may be chosen for six or more' : ''}.`);
  const replacingFirst = !!f.replacing && (!!f.replacingFirst || chainSale);
  const nonIndividual = f.buyerType === 'discretionary_trust' || f.buyerType === 'personal_representatives';
  const additionalProperty = !f.statutoryExtension && !(f.betweenSpouses && !f.anyOwnsOther) && (company || nonIndividual || several || (!!f.anyOwnsOther && !replacingFirst));
  if (company) reasons.push('A company buys: the higher rates always apply.');
  else if (f.anyOwnsOther && replacingFirst) reasons.push(`A buyer will own another dwelling, but this replaces their main residence, sold ${chainSale ? 'on the linked sale' : 'on or before completion'}: the replacement exception means no higher rates.`);
  else if (f.anyOwnsOther && f.replacing) reasons.push('A buyer will still own their old main residence at the end of the completion day: the higher rates apply now, refundable if it is sold within three years.');
  else if (f.anyOwnsOther) reasons.push('A buyer (or their spouse) will own another dwelling worth £40,000 or more at the end of the completion day: the higher rates apply.');
  else reasons.push('No buyer will own another dwelling at the end of the completion day: no higher rates.');
  const firstTimeBuyer = !company && !f.anyEverOwned && !!f.mainResidence && !additionalProperty;
  if (firstTimeBuyer) reasons.push("No buyer has ever owned a home and it will be their main residence: first-time buyers' relief.");
  else if (!f.anyEverOwned && !f.mainResidence && !company) reasons.push("First-time buyers' relief needs it to be their only or main residence: not claimed.");
  else if (f.anyEverOwned) reasons.push("A buyer has owned a home before: no first-time buyers' relief (every buyer must qualify).");
  if (f.buyerType === 'discretionary_trust') reasons.push('Trustees of a discretionary trust are treated like a company: the higher rates.');
  if (f.buyerType === 'bare_trust') reasons.push('A bare trust (or a life interest): the beneficiary is treated as the buyer; their holdings decide.');
  if (f.buyerType === 'personal_representatives') reasons.push('Personal representatives buying: the higher rates generally apply. An appropriation to a beneficiary without consideration is exempt.');
  if (f.buyerType === 'partnership') contradictions.push('A partnership buys: the partnership rules (FA 2003 Sch 15) apply. A person works out the tax.');
  if (f.buyerType === 'charity') reasons.push("A charity buys: charities relief is claimed on the return (clawed back if the charitable use stops within three years).");
  if (company && f.companyRelief) reasons.push(`Company relief claimed (${f.companyRelief}): the higher rates instead of the 17% flat rate, clawed back if the qualifying use stops within three years. Above £500,000 the company also files an ATED return each year unless a relief applies.`);
  if (s.shapes?.includes('right_to_buy')) reasons.push('Right to Buy: the tax is on the discounted price actually paid; the higher rates follow the usual tests.');
  if (f.statutoryExtension) reasons.push("A statutory lease extension of the buyer's own home: SDLT on the premium, not a higher-rates transaction.");
  if (f.betweenSpouses) reasons.push('A transfer between spouses or civil partners: the higher rates do not apply on that account.');
  if (f.uninhabitableClaim) contradictions.push('The buyer says the property is not suitable as a dwelling: a person decides whether the non-residential rates can be claimed (narrow case law: Bewley allowed, PN and Mudan refused). The estimate stays residential.');
  if (f.welshPercent && f.welshPercent > 0 && f.welshPercent < 100) contradictions.push(`The land straddles the border (${f.welshPercent}% in Wales): split the consideration on a just and reasonable basis, SDLT on the English part and LTT on the Welsh part.`);
  if (f.crownEmployee && f.anyNonResident) reasons.push('A Crown employee (or in the forces) serving abroad is treated as UK resident: no non-resident surcharge.');
  const nonUkResident = !!f.anyNonResident && !f.crownEmployee;
  if (nonUkResident) reasons.push(f.wales ? 'A buyer was non-UK resident, but LTT has no non-resident surcharge.' : 'A buyer was in the UK for fewer than 183 days in the last year: the 2% non-resident surcharge (refundable if they become resident within the following year).');
  if (f.wales) reasons.push('The property is in Wales: Land Transaction Tax, not SDLT.');
  if (f.mixedUse) reasons.push('Part of the property is non-residential: the mixed-use rates, if HMRC would accept the use as genuine.');
  // Shapes that cannot sit with these answers.
  if (s.shapes?.includes('lifetime_isa') && f.anyEverOwned) contradictions.push('A Lifetime ISA can only be used by a first-time buyer, but a buyer has owned a home before: the bonus cannot be used.');
  if (s.shapes?.includes('help_to_buy_isa') && f.anyEverOwned) contradictions.push('A Help to Buy ISA bonus is for first-time buyers only, but a buyer has owned a home before.');
  if (s.shapes?.includes('buy_to_let') && f.mainResidence) contradictions.push('Enrolled as a buy-to-let, but the answers say it will be the buyers\' main residence: one of them is wrong (and the lender must be told which).');
  if (s.shapes?.includes('buy_to_let') && firstTimeBuyer) contradictions.push("First-time buyers' relief is only for a main residence, not a buy-to-let.");
  return { basis: { firstTimeBuyer, additionalProperty, nonUkResident, company: company || nonIndividual, companyRelief: company && !!f.companyRelief, mixedUse: !!f.mixedUse, wales: !!f.wales, marketValuePennies: s.shapes?.includes('shared_ownership') ? f.soMarketValuePennies ?? null : null, newLeaseRentPennies: f.newLeaseRentPennies ?? null, newLeaseTermYears: f.newLeaseTermYears ?? null, effectiveDate: f.effectiveDate ?? null }, reasons, contradictions, refundDiary: !company && !!f.anyOwnsOther && !!f.replacing && !replacingFirst };
}

/** The seller's CGT position: flags for the client to take to their accountant, never a figure. */
export function cgtFlags(f: CgtFacts): string[] {
  const out: string[] = [];
  if (f.mainResidenceThroughout === false) out.push('Not the client\'s only or main home throughout: private residence relief may not cover the whole gain, so Capital Gains Tax may be due, reported and paid to HMRC within 60 days of completion.');
  if (f.absencesOrLet || f.businessUse || f.groundsOverHalfHectare || f.anotherResidence) out.push(`Private residence relief may only be partial (${[f.absencesOrLet && 'periods away or let', f.businessUse && 'business use', f.groundsOverHalfHectare && 'grounds over half a hectare', f.anotherResidence && 'more than one residence'].filter(Boolean).join(', ')}). The last nine months of ownership are always exempt; lettings relief now only covers shared occupation.`);
  if (f.partOfGarden) out.push('Selling part of the garden or a plot (or land kept after the house was sold): private residence relief may not apply, especially once the house has gone.');
  if (f.sellerType === 'company') out.push("The seller is a company: corporation tax on the gain, not CGT. For the company's accountant only.");
  if (f.sellerType === 'personal_representatives' || f.sellerType === 'trustees') out.push(`The seller is ${f.sellerType === 'trustees' ? 'trustees' : 'personal representatives'}: the ${f.sellerType === 'trustees' ? "trust's" : "estate's"} own CGT, with a 60-day return if a gain is due.`);
  if (f.giftToConnected) out.push('A gift, or a sale to family below value: CGT is worked out on the market value, not the price.');
  if (f.ukResident === false) out.push('The client is not UK resident: a non-resident must report the disposal of UK property to HMRC within 60 days of completion even when no tax is due.');
  return out;
}

/** What the tax is charged on: the price, or on a transfer of equity the cash plus any mortgage debt taken on. */
export function chargeableConsideration(s: MatterState): number | null {
  if (s.transactionType === 'transfer_of_equity') {
    const debt = (s.sdltFacts as SdltFacts | null | undefined)?.debtAssumedPennies ?? 0;
    return s.considerationPennies != null || debt ? (s.considerationPennies ?? 0) + debt : null;
  }
  // Shared ownership (money.md 7.8): with the election, the tax is on the full market value now and staircasing later is free; without it, on the share's price.
  const f = s.sdltFacts as SdltFacts | null | undefined;
  if (s.shapes?.includes('shared_ownership') && f?.soMarketValue && f.soMarketValuePennies) return f.soMarketValuePennies;
  // VAT is part of the price (E4); a part-exchange is consideration too (E5).
  if (s.purchasePricePennies == null) return null;
  return s.purchasePricePennies + (f?.vatPennies ?? 0) + (f?.partExchangePennies ?? 0);
}

/** Why no SDLT return is due, when one is not (tax.md H10, F5, A12): the engine proposes it with its reason. */
export function noReturnReason(s: Pick<MatterState, 'transactionType' | 'purchasePricePennies' | 'considerationPennies' | 'sdltFacts' | 'shapes'>): string | null {
  if (s.shapes?.includes('court_order_transfer')) return 'A transfer under a court order on divorce or separation: exempt (FA 2003 Sch 3 para 3), no return.';
  const c = chargeableConsideration(s as MatterState);
  if (s.transactionType === 'transfer_of_equity' && !c) return 'A gift: no money paid and no mortgage taken on, so no chargeable consideration and no return.';
  if (c != null && c < 4_000_000) return `Chargeable consideration £${(c / 100).toLocaleString('en-GB')}: under £40,000, so no return.`;
  return null;
}
