/**
 * England and Wales only (tax.md H9): Scottish land (LBTT, Scottish conveyancing) and Northern Irish land are out of
 * scope, and a case for one is refused when it is created. Read from the postcode; a cross-border postcode is let
 * through for a person to check (TD12 and TD15 cover land on both sides of the Tweed).
 */
const SCOTTISH = /^(AB|DD|DG|EH|FK|G|HS|IV|KA|KW|KY|ML|PA|PH|TD|ZE)(\d{1,2})$/;

export function outOfJurisdiction(address: string | null | undefined): string | null {
  const m = (address ?? '').toUpperCase().match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*\d[A-Z]{2}\b\s*$/);
  if (!m) return null;
  const outward = m[1].replace(/[A-Z]$/, (c) => (/\d[A-Z]$/.test(m[1]) ? '' : c));
  if (/^BT\d/.test(outward)) return 'This property is in Northern Ireland: CONVEYi handles land in England and Wales only.';
  const sc = outward.match(SCOTTISH);
  if (sc && !(sc[1] === 'TD' && ['12', '15'].includes(sc[2]))) return 'This property is in Scotland: Scottish conveyancing and LBTT are outside what CONVEYi handles (England and Wales only).';
  return null;
}
