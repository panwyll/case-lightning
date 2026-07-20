/**
 * Structured UK property address, shared by the add-in House tab and the
 * New matter form.
 *
 * `matter.property_address` stays the canonical display string — the parts in
 * `matter.address_parts` are what the UI actually edits, recomposing the string
 * on save. Keeping both means legacy freeform addresses keep rendering while
 * newly-edited ones gain structure.
 */
export type AddrParts = { building: string; street: string; town: string; postcode: string; country: string };

export const EMPTY_ADDR: AddrParts = { building: '', street: '', town: '', postcode: '', country: '' };

export const UK_POSTCODE_RE = /([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})/i;

/** Parts → the one-line display string stored in property_address. */
export function composeAddress(a: AddrParts): string {
  const line1 = [a.building, a.street].map((s) => (s || '').trim()).filter(Boolean).join(' ');
  return [line1, a.town, a.postcode, a.country].map((s) => (s || '').trim()).filter(Boolean).join(', ');
}

/**
 * Best-effort split of a legacy freeform address into parts (only used until the
 * first structured edit persists address_parts). Pulls out a UK postcode, treats
 * the last comma segment as the town and the rest as the street; the user can
 * tidy building/country.
 */
export function parseAddress(s: string): AddrParts {
  if (!s) return { ...EMPTY_ADDR };
  const pcM = s.match(UK_POSTCODE_RE);
  const postcode = pcM ? `${pcM[1].toUpperCase()} ${pcM[2].toUpperCase()}` : '';
  const segs = (pcM ? s.replace(pcM[0], '') : s).split(',').map((x) => x.trim()).filter(Boolean);
  const town = segs.length >= 2 ? segs[segs.length - 1] : '';
  const street = segs.length >= 2 ? segs.slice(0, -1).join(', ') : segs[0] || '';
  return { building: '', street, town, postcode, country: '' };
}
