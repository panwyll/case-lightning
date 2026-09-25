/**
 * Recognising a property from how people actually write it in an email: "9 Arthur Road
 * contract pack", "re 9 Arthur Rd", "Flat 2, 9 Arthur Road". A postcode is rarely in a
 * subject line; the house number and street nearly always are.
 *
 * The key is "<number> <street words>", lower case, punctuation gone and the common
 * street abbreviations spelled out, so "9 Arthur Rd" and "9, Arthur Road" are the same.
 */
const SUFFIX: Record<string, string> = {
  rd: 'road', st: 'street', ave: 'avenue', av: 'avenue', ln: 'lane', cl: 'close', dr: 'drive', gdns: 'gardens',
  gdn: 'garden', cres: 'crescent', ct: 'court', pl: 'place', sq: 'square', tce: 'terrace', ter: 'terrace', gr: 'grove',
  pk: 'park', wy: 'way', hl: 'hill', mws: 'mews', blvd: 'boulevard', pde: 'parade', wlk: 'walk', grn: 'green',
};

export function normaliseAddressText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SUFFIX[w] ?? w)
    .join(' ');
}

const NUMBER_STREET = /\b(\d{1,4}[a-z]?)\s+((?:[a-z]+\s+){0,3}[a-z]+)/;

/**
 * The "<number> <street>" key of a case's property address, from the first part of it
 * that starts with a house number: "Flat 2, 9 Arthur Road, Leeds LS6 1AB" → "9 arthur road".
 * Null when the address has no numbered street (a named house, a plot).
 */
export function streetKeyOf(propertyAddress: string | null | undefined): { key: string; label: string } | null {
  if (!propertyAddress) return null;
  for (const part of propertyAddress.split(',')) {
    const n = normaliseAddressText(part);
    const m = n.match(/(?:^|\s)(\d{1,4}[a-z]?)\s+([a-z]+(?:\s+[a-z]+){0,3})$/) ?? n.match(NUMBER_STREET);
    if (m && /[a-z]{3,}/.test(m[2])) {
      // Drop a trailing postcode fragment or town the first part sometimes carries.
      const words = m[2].split(' ').filter((w) => !/\d/.test(w));
      if (!words.length) continue;
      return { key: `${m[1]} ${words.join(' ')}`, label: part.trim() };
    }
  }
  return null;
}

/**
 * The "<number> <first street word>" openings in a piece of text, for the database to
 * narrow on ("9 arthur"). Each is only a lead: a case matches when its full street key
 * appears in the text (see mentionsStreet).
 */
export function streetLeads(text: string): string[] {
  const n = normaliseAddressText(text);
  const out = new Set<string>();
  for (const m of n.matchAll(/\b(\d{1,4}[a-z]?)\s+([a-z]{3,})\b/g)) out.add(`${m[1]} ${m[2]}`);
  return [...out].slice(0, 40);
}

/** Does the text mention this street key as whole words ("9 arthur road", not "19 arthur road")? */
export function mentionsStreet(text: string, key: string): boolean {
  const n = ` ${normaliseAddressText(text)} `;
  return n.includes(` ${key} `);
}
