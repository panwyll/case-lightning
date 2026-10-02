/**
 * Stamp Duty Land Tax on a residential purchase in England and Northern Ireland: the sum the
 * basis the client declared implies, band by band, so the completion statement and the SDLT
 * deadline carry a figure and the person filing the return sees what it rests on.
 *
 * Deterministic and dated. The rates are those in force from 1 April 2025 (the temporary
 * thresholds of 2022–25 having ended). It is an ESTIMATE: reliefs the form does not ask about
 * (multiple dwellings relief was abolished in 2024; mixed use; linked transactions; a replaced
 * main residence exception to the higher rates) are for the person to apply, and the note says so.
 */
export interface SdltBasis {
  firstTimeBuyer: boolean;
  additionalProperty: boolean;
  nonUkResident: boolean;
  /** A company or other non-natural buyer: the higher rates apply, and the 17% flat rate above £500,000 unless a relief applies. */
  company?: boolean;
  /** Mixed use (a shop with a flat, a house with agricultural land): the non-residential rates, no surcharges, no reliefs. */
  mixedUse?: boolean;
  /** A company claiming a relief from the 17% rate (property rental business, development, trading): the higher rates instead. */
  companyRelief?: boolean;
  /** Linked transactions: the other consideration between the same parties; the rate is set on the total and this purchase pays its share. */
  linkedConsiderationPennies?: number | null;
  /** The property is in Wales: Land Transaction Tax to the Welsh Revenue Authority, not SDLT (ltt below). */
  wales?: boolean;
  /** Shared ownership paying in stages: first-time buyers' relief is tested on the full market value (tax.md B7). */
  marketValuePennies?: number | null;
  /** The grant of a new lease: 1% on the net present value of the rent above £125,000 (tax.md F1). */
  newLeaseRentPennies?: number | null;
  newLeaseTermYears?: number | null;
  /** The effective date, to choose the dated rates (tax.md E11). */
  effectiveDate?: string | null;
}

/** The net present value of a lease's rent (FA 2003 Sch 5: 3.5% a year), and the 1% above £125,000 on it. */
export function leaseRentTax(rentPennies: number, years: number): { npvPennies: number; taxPennies: number } {
  let npv = 0;
  for (let i = 1; i <= Math.min(years, 999); i++) npv += rentPennies / Math.pow(1.035, i);
  const npvPennies = Math.round(npv);
  return { npvPennies, taxPennies: Math.max(0, Math.round((npvPennies - 12_500_000) * 0.01)) };
}
export interface SdltBand { fromPennies: number; toPennies: number | null; rate: number; taxPennies: number }
export interface SdltEstimate {
  totalPennies: number;
  bands: SdltBand[];
  /** Which schedule of rates was used, in words. */
  scheme: string;
  notes: string[];
  ratesFrom: string;
}

const RATES_FROM = '2025-04-01';
/** Standard residential bands from 1 April 2025 (thresholds in pounds). */
const STANDARD: Array<[number, number | null, number]> = [[0, 125_000, 0], [125_000, 250_000, 0.02], [250_000, 925_000, 0.05], [925_000, 1_500_000, 0.10], [1_500_000, null, 0.12]];
/** First-time buyer relief from 1 April 2025: 0% to £300,000, 5% to £500,000; no relief above £500,000. */
const FIRST_TIME: Array<[number, number | null, number]> = [[0, 300_000, 0], [300_000, 500_000, 0.05]];
const FTB_CEILING = 500_000;
/** The higher rates for additional dwellings: 5 percentage points on every band (from 31 October 2024). */
const ADDITIONAL_SURCHARGE = 0.05;
/** The non-UK resident surcharge: 2 percentage points on every band (from 1 April 2021). */
const NON_RESIDENT_SURCHARGE = 0.02;
/** Non-residential and mixed-use bands (unchanged since 2016). */
const NON_RESIDENTIAL: Array<[number, number | null, number]> = [[0, 150_000, 0], [150_000, 250_000, 0.02], [250_000, null, 0.05]];
const COMPANY_FLAT_THRESHOLD = 500_000;
const COMPANY_FLAT_RATE = 0.17;
/** Below this, a purchase is not a higher-rates transaction and the non-resident surcharge does not apply (FA 2003 Sch 4ZA para 2; Sch 9A). */
const SURCHARGE_FLOOR = 40_000;

export function computeSdlt(pricePennies: number, basis: SdltBasis): SdltEstimate {
  if (basis.wales) return computeLtt(pricePennies, basis);
  const linked = basis.linkedConsiderationPennies ?? 0;
  if (linked > 0) {
    // The rate is set on the aggregate; this transaction bears its proportion (FA 2003 s.55(4)).
    const whole = computeSdlt(pricePennies + linked, { ...basis, linkedConsiderationPennies: null });
    const share = pricePennies / (pricePennies + linked);
    const tax = Math.round(whole.totalPennies * share);
    return { totalPennies: tax, bands: whole.bands.map((b) => ({ ...b, taxPennies: Math.round(b.taxPennies * share) })), scheme: `${whole.scheme}, linked transactions`, notes: [`Linked with other consideration of £${(linked / 100).toLocaleString('en-GB')} between the same parties: the rates are set on the aggregate £${((pricePennies + linked) / 100).toLocaleString('en-GB')} and this purchase bears ${(share * 100).toFixed(1)}% of the tax.`, ...whole.notes], ratesFrom: whole.ratesFrom };
  }
  const price = pricePennies / 100;
  const notes: string[] = [];
  if (basis.effectiveDate && basis.effectiveDate.slice(0, 10) < RATES_FROM) notes.push(`The effective date (${basis.effectiveDate.slice(0, 10)}) is before these rates (from ${RATES_FROM}): the rates in force on that date apply. Check HMRC's calculator for it.`);
  if (basis.mixedUse) {
    const bands: SdltBand[] = [];
    let total = 0;
    for (const [from, to, rate] of NON_RESIDENTIAL) {
      if (price <= from) break;
      const slice = (to == null ? price : Math.min(price, to)) - from;
      const tax = Math.round(slice * rate * 100);
      bands.push({ fromPennies: from * 100, toPennies: to == null ? null : to * 100, rate, taxPennies: tax });
      total += tax;
    }
    notes.push('Mixed use: the non-residential rates on the whole price; no higher-rates surcharge, no non-resident surcharge and no first-time buyer relief. HMRC looks hard at "mixed use" claims: the non-residential part must be genuine (a working farm, a shop), not a paddock or a strip of woodland.');
    return { totalPennies: total, bands, scheme: 'non-residential / mixed-use rates', notes, ratesFrom: RATES_FROM };
  }
  const belowFloor = price < SURCHARGE_FLOOR;
  const surcharge = belowFloor ? 0 : (basis.additionalProperty || basis.company ? ADDITIONAL_SURCHARGE : 0) + (basis.nonUkResident ? NON_RESIDENT_SURCHARGE : 0);
  if (belowFloor && (basis.additionalProperty || basis.company || basis.nonUkResident)) notes.push('Under £40,000: not a higher-rates transaction, and the non-resident surcharge does not apply.');
  let table = STANDARD;
  let scheme = 'standard residential rates';
  if (basis.company && price > COMPANY_FLAT_THRESHOLD && !basis.companyRelief) {
    // The 17% flat rate, plus the non-resident surcharge for a non-UK company: 19%.
    const rate = COMPANY_FLAT_RATE + (basis.nonUkResident ? NON_RESIDENT_SURCHARGE : 0);
    const tax = Math.round(pricePennies * rate);
    notes.push(`A company buying a dwelling for more than £500,000 pays the 17% flat rate${basis.nonUkResident ? ', 19% as a non-UK company' : ''} unless a relief applies (property rental business, development, trading); with a relief the higher rates are charged instead, and the relief is clawed back if the use changes within three years.`);
    return { totalPennies: tax, bands: [{ fromPennies: 0, toPennies: null, rate, taxPennies: tax }], scheme: `company: ${Math.round(rate * 100)}% flat rate above £500,000`, notes, ratesFrom: RATES_FROM };
  }
  if (basis.company && basis.companyRelief) notes.push('Company relief claimed (rental business, development or trading): the higher rates instead of the 17% flat rate. Clawed back if the qualifying use stops within three years.');
  if (basis.firstTimeBuyer && !basis.additionalProperty && !basis.company) {
    const tested = basis.marketValuePennies ? basis.marketValuePennies / 100 : price;
    if (tested <= FTB_CEILING) { table = FIRST_TIME; scheme = "first-time buyers' relief"; if (basis.marketValuePennies) notes.push("Shared ownership in stages: the relief is tested on the market value in the lease (£500,000 or less) and the tax is on this share; later staircasing to 80% or less pays nothing."); }
    else notes.push(`First-time buyers' relief is not available above £${FTB_CEILING.toLocaleString('en-GB')}: standard rates apply to the whole price.`);
  } else if (basis.firstTimeBuyer && basis.additionalProperty) {
    notes.push("First-time buyers' relief cannot be claimed where the higher rates apply.");
  }
  const bands: SdltBand[] = [];
  let total = 0;
  for (const [from, to, rate] of table) {
    if (price <= from) break;
    const upper = to == null ? price : Math.min(price, to);
    const slice = upper - from;
    const effective = rate + surcharge;
    const tax = Math.round(slice * effective * 100);
    bands.push({ fromPennies: from * 100, toPennies: to == null ? null : to * 100, rate: effective, taxPennies: tax });
    total += tax;
  }
  if (basis.newLeaseRentPennies && basis.newLeaseTermYears) {
    const r = leaseRentTax(basis.newLeaseRentPennies, basis.newLeaseTermYears);
    if (r.taxPennies > 0) { total += r.taxPennies; bands.push({ fromPennies: 12_500_000, toPennies: null, rate: 0.01, taxPennies: r.taxPennies }); }
    notes.push(`A new lease: SDLT on the premium${r.taxPennies ? `, plus 1% on the rent's net present value above £125,000 (NPV £${(r.npvPennies / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })})` : ` (the rent's net present value, £${(r.npvPennies / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}, is under £125,000)`}.`);
  }
  if (basis.additionalProperty) notes.push('Higher rates (additional dwellings): every band carries 5 percentage points more. Not due if the purchase replaces the buyer\'s only or main residence sold within the last three years; refundable if the previous main residence is sold within three years.');
  if (basis.nonUkResident) notes.push('Non-UK resident surcharge: 2 percentage points on every band, refundable if the buyer is UK resident for 183 days in any continuous 365-day period from one year before to one year after the purchase (claim within two years of the purchase).');
  notes.push('An estimate on the declared basis for a single dwelling. Linked transactions, mixed use, chattels apportionment and any other relief are for the person filing the return; check against HMRC\'s calculator before filing.');
  return { totalPennies: total, bands, scheme, notes, ratesFrom: RATES_FROM };
}

export const sdltLabel = (b: SdltBasis): string => [b.wales && 'Wales (LTT)', b.mixedUse && 'mixed use', b.company && 'company', b.firstTimeBuyer && 'first-time buyer', b.additionalProperty && 'additional property', b.nonUkResident && 'non-UK resident', (b.linkedConsiderationPennies ?? 0) > 0 && 'linked transactions'].filter(Boolean).join(', ') || 'standard';

// ───────────────────────────── Wales: Land Transaction Tax ─────────────────────────────

const LTT_FROM = '2024-12-11';
/** LTT main residential rates (from 10 October 2022). */
const LTT_MAIN: Array<[number, number | null, number]> = [[0, 225_000, 0], [225_000, 400_000, 0.06], [400_000, 750_000, 0.075], [750_000, 1_500_000, 0.10], [1_500_000, null, 0.12]];
/** LTT higher residential rates (from 11 December 2024). */
const LTT_HIGHER: Array<[number, number | null, number]> = [[0, 180_000, 0.05], [180_000, 250_000, 0.085], [250_000, 400_000, 0.10], [400_000, 750_000, 0.125], [750_000, 1_500_000, 0.15], [1_500_000, null, 0.17]];
/** LTT non-residential and mixed-use rates. */
const LTT_NON_RESIDENTIAL: Array<[number, number | null, number]> = [[0, 225_000, 0], [225_000, 250_000, 0.01], [250_000, 1_000_000, 0.05], [1_000_000, null, 0.06]];

/**
 * Land Transaction Tax (Wales): no first-time buyer relief and no non-resident surcharge; the higher rates are their
 * own table (companies always pay them); the return goes to the Welsh Revenue Authority within 30 days.
 */
export function computeLtt(pricePennies: number, basis: SdltBasis): SdltEstimate {
  const price = pricePennies / 100;
  const notes: string[] = ['Wales: Land Transaction Tax, returned to the Welsh Revenue Authority within 30 days of completion.'];
  const higher = !basis.mixedUse && price >= 40_000 && (basis.additionalProperty || basis.company);
  const table = basis.mixedUse ? LTT_NON_RESIDENTIAL : higher ? LTT_HIGHER : LTT_MAIN;
  if (basis.firstTimeBuyer) notes.push("LTT has no first-time buyer relief: the main rates apply.");
  if (basis.nonUkResident) notes.push('LTT has no non-resident surcharge.');
  const bands: SdltBand[] = [];
  let total = 0;
  for (const [from, to, rate] of table) {
    if (price <= from) break;
    const slice = (to == null ? price : Math.min(price, to)) - from;
    const tax = Math.round(slice * rate * 100);
    bands.push({ fromPennies: from * 100, toPennies: to == null ? null : to * 100, rate, taxPennies: tax });
    total += tax;
  }
  return { totalPennies: total, bands, scheme: basis.mixedUse ? 'LTT non-residential rates' : higher ? 'LTT higher residential rates' : 'LTT main residential rates', notes, ratesFrom: LTT_FROM };
}
