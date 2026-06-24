/**
 * Human-friendly matter references.
 *
 * An auto-generated matter is named after the people and place it concerns —
 * a truncated CLIENT-ADDRESS ref like "SMITH-14OAK" or "JONES-SW1A". That's how
 * conveyancers actually refer to a file, and it's far easier to remember and spot
 * than an opaque number or a random codename. When there's genuinely no client or
 * address to go on, we fall back to a short neutral token ("MATTER-K7Q2").
 *
 * Pure and isomorphic: safe to import from both server code and client
 * components (no Node-only or browser-only APIs).
 */

/**
 * Build a matter ref from the client surname + a short locator from the address.
 * Returns '' when there's nothing to build from, so callers can fall back.
 * e.g. {buyerNames:['Jane Smith'], propertyAddress:'14 Oak Street, SW1A 1AA'} → "SMITH-SW1A".
 */
export function matterRefFrom(input: {
  buyerNames?: string[] | null;
  sellerNames?: string[] | null;
  propertyAddress?: string | null;
}): string {
  const surname = ((input.buyerNames?.[0] || input.sellerNames?.[0]) ?? '').trim().split(/\s+/).pop() || '';
  const who = surname.replace(/[^A-Za-z-]/g, '').toUpperCase();

  const addr = (input.propertyAddress ?? '').toUpperCase();
  const pc = addr.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/); // postcode outward code
  const street = addr.match(/\b(\d+)\s+([A-Z]+)/); // "14 OAK"
  const word = addr.match(/[A-Z]{2,}/); // first real word as a last resort
  const where = pc ? pc[1] : street ? `${street[1]}${street[2]}` : word ? word[0] : '';

  const parts = [who, where].filter(Boolean);
  return parts.length ? parts.join('-').slice(0, 24) : '';
}

/** A short neutral ref for when there's no client/address to derive one from. */
export function fallbackMatterRef(): string {
  return `MATTER-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/**
 * True when a candidate reference is human-meaningful rather than machine junk.
 * Used to reject AI-proposed refs like a stray "20458282380320" lifted from an
 * email so we fall back to a derived ref instead.
 */
export function isMeaningfulRef(ref: string | null | undefined): boolean {
  const r = (ref ?? '').trim();
  if (r.length < 2) return false;
  if (!/[A-Za-z]/.test(r)) return false; // must contain a letter, not pure digits/punctuation
  if (/^\d[\d\s-]{4,}$/.test(r)) return false; // long number-like strings (phone/ref numbers)
  return true;
}
