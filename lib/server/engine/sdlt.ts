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
const COMPANY_FLAT_THRESHOLD = 500_000;
const COMPANY_FLAT_RATE = 0.17;

export function computeSdlt(pricePennies: number, basis: SdltBasis): SdltEstimate {
  const price = pricePennies / 100;
  const notes: string[] = [];
  const surcharge = (basis.additionalProperty || basis.company ? ADDITIONAL_SURCHARGE : 0) + (basis.nonUkResident ? NON_RESIDENT_SURCHARGE : 0);
  let table = STANDARD;
  let scheme = 'standard residential rates';
  if (basis.company && price > COMPANY_FLAT_THRESHOLD) {
    const tax = Math.round(pricePennies * COMPANY_FLAT_RATE);
    notes.push('A company buying a dwelling for more than £500,000 pays the 17% flat rate unless a relief applies (property rental business, development, trading); if a relief applies the higher rates are charged instead.');
    return { totalPennies: tax, bands: [{ fromPennies: 0, toPennies: null, rate: COMPANY_FLAT_RATE, taxPennies: tax }], scheme: 'company: 17% flat rate above £500,000', notes, ratesFrom: RATES_FROM };
  }
  if (basis.firstTimeBuyer && !basis.additionalProperty && !basis.company) {
    if (price <= FTB_CEILING) { table = FIRST_TIME; scheme = "first-time buyers' relief"; }
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
  if (basis.additionalProperty) notes.push('Higher rates (additional dwellings): every band carries 5 percentage points more. Not due if the purchase replaces the buyer\'s only or main residence sold within the last three years; refundable if the previous main residence is sold within three years.');
  if (basis.nonUkResident) notes.push('Non-UK resident surcharge: 2 percentage points on every band, refundable if the buyer becomes UK resident (183 days) within the two years around completion.');
  notes.push('An estimate on the declared basis for a single dwelling. Linked transactions, mixed use, chattels apportionment and any other relief are for the person filing the return; check against HMRC\'s calculator before filing.');
  return { totalPennies: total, bands, scheme, notes, ratesFrom: RATES_FROM };
}

export const sdltLabel = (b: SdltBasis): string => [b.company && 'company', b.firstTimeBuyer && 'first-time buyer', b.additionalProperty && 'additional property', b.nonUkResident && 'non-UK resident'].filter(Boolean).join(', ') || 'standard';
