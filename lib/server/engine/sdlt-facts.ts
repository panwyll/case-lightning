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
}

export interface CgtFacts {
  /** The client's only or main home for the whole time they owned it. */
  mainResidenceThroughout?: boolean;
  /** UK resident for tax. */
  ukResident?: boolean;
}

export interface DerivedBasis { basis: SdltBasis & { wales?: boolean }; reasons: string[]; contradictions: string[]; refundDiary: boolean }

/** The basis from the facts, with the fact behind each answer. */
export function deriveSdltBasis(f: SdltFacts, s: Pick<MatterState, 'shapes' | 'relatedMatter'>): DerivedBasis {
  const company = s.shapes?.includes('company_buyer') ?? false;
  const reasons: string[] = [];
  const contradictions: string[] = [];
  // A linked sale of the client's own home completes no later than this purchase: the machine holds it that way.
  const chainSale = s.relatedMatter?.relation === 'sale';
  const replacingFirst = !!f.replacing && (!!f.replacingFirst || chainSale);
  const additionalProperty = company || (!!f.anyOwnsOther && !replacingFirst);
  if (company) reasons.push('A company buys: the higher rates always apply.');
  else if (f.anyOwnsOther && replacingFirst) reasons.push(`A buyer will own another dwelling, but this replaces their main residence, sold ${chainSale ? 'on the linked sale' : 'on or before completion'}: the replacement exception means no higher rates.`);
  else if (f.anyOwnsOther && f.replacing) reasons.push('A buyer will still own their old main residence at the end of the completion day: the higher rates apply now, refundable if it is sold within three years.');
  else if (f.anyOwnsOther) reasons.push('A buyer (or their spouse) will own another dwelling worth £40,000 or more at the end of the completion day: the higher rates apply.');
  else reasons.push('No buyer will own another dwelling at the end of the completion day: no higher rates.');
  const firstTimeBuyer = !company && !f.anyEverOwned && !!f.mainResidence && !additionalProperty;
  if (firstTimeBuyer) reasons.push("No buyer has ever owned a home and it will be their main residence: first-time buyers' relief.");
  else if (!f.anyEverOwned && !f.mainResidence && !company) reasons.push("First-time buyers' relief needs it to be their only or main residence: not claimed.");
  else if (f.anyEverOwned) reasons.push("A buyer has owned a home before: no first-time buyers' relief (every buyer must qualify).");
  const nonUkResident = !!f.anyNonResident;
  if (nonUkResident) reasons.push(f.wales ? 'A buyer was non-UK resident, but LTT has no non-resident surcharge.' : 'A buyer was in the UK for fewer than 183 days in the last year: the 2% non-resident surcharge (refundable if they become resident within the following year).');
  if (f.wales) reasons.push('The property is in Wales: Land Transaction Tax, not SDLT.');
  if (f.mixedUse) reasons.push('Part of the property is non-residential: the mixed-use rates, if HMRC would accept the use as genuine.');
  // Shapes that cannot sit with these answers.
  if (s.shapes?.includes('lifetime_isa') && f.anyEverOwned) contradictions.push('A Lifetime ISA can only be used by a first-time buyer, but a buyer has owned a home before: the bonus cannot be used.');
  if (s.shapes?.includes('help_to_buy_isa') && f.anyEverOwned) contradictions.push('A Help to Buy ISA bonus is for first-time buyers only, but a buyer has owned a home before.');
  if (s.shapes?.includes('buy_to_let') && f.mainResidence) contradictions.push('Enrolled as a buy-to-let, but the answers say it will be the buyers\' main residence: one of them is wrong (and the lender must be told which).');
  if (s.shapes?.includes('buy_to_let') && firstTimeBuyer) contradictions.push("First-time buyers' relief is only for a main residence, not a buy-to-let.");
  return { basis: { firstTimeBuyer, additionalProperty, nonUkResident, company, mixedUse: !!f.mixedUse, wales: !!f.wales }, reasons, contradictions, refundDiary: !company && !!f.anyOwnsOther && !!f.replacing && !replacingFirst };
}

/** The seller's CGT position: flags for the client to take to their accountant, never a figure. */
export function cgtFlags(f: CgtFacts): string[] {
  const out: string[] = [];
  if (f.mainResidenceThroughout === false) out.push('Not the client\'s only or main home throughout: private residence relief may not cover the whole gain, so Capital Gains Tax may be due, reported and paid to HMRC within 60 days of completion.');
  if (f.ukResident === false) out.push('The client is not UK resident: a non-resident must report the disposal of UK property to HMRC within 60 days of completion even when no tax is due.');
  return out;
}

/** What the tax is charged on: the price, or on a transfer of equity the cash plus any mortgage debt taken on. */
export function chargeableConsideration(s: MatterState): number | null {
  if (s.transactionType === 'transfer_of_equity') {
    const debt = (s.sdltFacts as SdltFacts | null | undefined)?.debtAssumedPennies ?? 0;
    return s.considerationPennies != null || debt ? (s.considerationPennies ?? 0) + debt : null;
  }
  return s.purchasePricePennies ?? null;
}
