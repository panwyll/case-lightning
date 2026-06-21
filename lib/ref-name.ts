/**
 * Human-friendly matter references.
 *
 * Instead of opaque numbers (e.g. "20458282380320") or ugly surname+address
 * mashups (e.g. "ANWYL_14-oak-street"), an auto-generated matter gets a
 * memorable two-word codename in the "adjective-animal" style — e.g.
 * "jumping-frog", "illustrious-owl", "swift-otter". Easy to say on the phone,
 * easy to spot in a folder list, and fun. Collisions are rare, and the
 * matter-create path already retries with a numeric suffix when they happen.
 *
 * Pure and isomorphic: safe to import from both server code and client
 * components (no Node-only or browser-only APIs).
 */

const ADJECTIVES = [
  'amber', 'bold', 'brave', 'bright', 'brisk', 'calm', 'clever', 'cosmic',
  'crimson', 'dapper', 'daring', 'dashing', 'eager', 'electric', 'fearless',
  'fierce', 'gallant', 'gentle', 'giddy', 'gilded', 'glowing', 'golden',
  'graceful', 'grand', 'happy', 'hardy', 'humble', 'illustrious', 'jolly',
  'jovial', 'jumping', 'keen', 'leaping', 'lively', 'lucky', 'lunar', 'mellow',
  'merry', 'mighty', 'nimble', 'noble', 'plucky', 'prancing', 'proud', 'quirky',
  'radiant', 'rapid', 'regal', 'roaming', 'royal', 'rustic', 'sage', 'scarlet',
  'soaring', 'spry', 'sterling', 'stoic', 'sunny', 'swift', 'valiant', 'velvet',
  'vivid', 'witty', 'zesty',
];

const ANIMALS = [
  'badger', 'beaver', 'bison', 'falcon', 'ferret', 'finch', 'fox', 'frog',
  'gecko', 'hare', 'heron', 'ibis', 'jay', 'kestrel', 'kingfisher', 'koala',
  'lark', 'lemur', 'leopard', 'lion', 'lynx', 'magpie', 'marmot', 'marten',
  'mink', 'mole', 'moose', 'narwhal', 'newt', 'ocelot', 'osprey', 'otter',
  'owl', 'panda', 'panther', 'pelican', 'puffin', 'quail', 'rabbit', 'raven',
  'robin', 'salmon', 'seal', 'shrew', 'sparrow', 'stag', 'stoat', 'swan',
  'tiger', 'toad', 'vole', 'walrus', 'weasel', 'whale', 'wolf', 'wombat',
  'wren',
];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** A memorable matter reference, e.g. "jumping-frog" or "illustrious-owl". */
export function randomMatterRef(): string {
  // adjective + animal → 65 × 57 ≈ 3.7k combinations; the matter-create path
  // retries with a numeric suffix on the rare collision.
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
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
