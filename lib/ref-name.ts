/**
 * Human-friendly matter references.
 *
 * Instead of opaque numbers (e.g. "20458282380320"), an auto-generated matter
 * gets a memorable codename in the established "adjective-noun-noun" style used
 * by Heroku/Docker/GitHub — e.g. "amber-cedar-harbor". Easy to say on the phone,
 * easy to spot in a folder list, and unique enough that collisions are rare (and
 * the matter-create path already retries with a numeric suffix when they happen).
 *
 * Pure and isomorphic: safe to import from both server code and client
 * components (no Node-only or browser-only APIs).
 */

const ADJECTIVES = [
  'amber', 'azure', 'bright', 'brisk', 'calm', 'clear', 'coastal', 'copper',
  'crisp', 'dawn', 'deep', 'eager', 'early', 'fair', 'fleet', 'fresh', 'gentle',
  'golden', 'grand', 'green', 'hardy', 'ivory', 'keen', 'level', 'lively',
  'lunar', 'maple', 'mellow', 'noble', 'north', 'olive', 'open', 'plain',
  'prime', 'quiet', 'rapid', 'ready', 'royal', 'rustic', 'sage', 'sharp',
  'silver', 'solid', 'spring', 'steady', 'still', 'stone', 'sunny', 'swift',
  'tidy', 'true', 'upper', 'vivid', 'warm', 'willow', 'winter',
];

const NOUNS = [
  'acre', 'anchor', 'arbor', 'ash', 'aspen', 'bay', 'beacon', 'birch',
  'bridge', 'brook', 'cedar', 'cliff', 'cove', 'crest', 'dale', 'delta',
  'dune', 'elm', 'fern', 'field', 'ford', 'forest', 'gable', 'garden',
  'gate', 'glen', 'grove', 'harbor', 'haven', 'heath', 'hill', 'holly',
  'isle', 'lake', 'lane', 'ledge', 'maple', 'meadow', 'mill', 'moor',
  'oak', 'orchard', 'park', 'pine', 'pond', 'reef', 'ridge', 'river',
  'shore', 'spring', 'summit', 'thorn', 'vale', 'vista', 'wharf', 'willow',
];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** A memorable matter reference, e.g. "amber-cedar-harbor". */
export function randomMatterRef(): string {
  // adjective + two distinct nouns → ~57 × 56 × 55 ≈ 175k combinations.
  const noun1 = pick(NOUNS);
  let noun2 = pick(NOUNS);
  while (noun2 === noun1) noun2 = pick(NOUNS);
  return `${pick(ADJECTIVES)}-${noun1}-${noun2}`;
}

/**
 * True when a candidate reference is human-meaningful rather than machine junk.
 * Used to reject AI-proposed refs like a stray "20458282380320" lifted from an
 * email so we fall back to a friendly codename instead.
 */
export function isMeaningfulRef(ref: string | null | undefined): boolean {
  const r = (ref ?? '').trim();
  if (r.length < 2) return false;
  if (!/[A-Za-z]/.test(r)) return false; // must contain a letter, not pure digits/punctuation
  if (/^\d[\d\s-]{4,}$/.test(r)) return false; // long number-like strings (phone/ref numbers)
  return true;
}
