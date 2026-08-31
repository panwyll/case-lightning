import { GuestSchema, type Guest } from './guest-schema';
import { guestFiles } from '@/content/guests';

/**
 * Guest content is config-as-code: one JSON file per guest, validated once at
 * module load. A malformed file fails loudly at build time rather than
 * rendering a broken page for someone we care about.
 */

function loadAll(): Map<string, Guest> {
  const out = new Map<string, Guest>();
  const problems: string[] = [];

  for (const [key, raw] of Object.entries(guestFiles)) {
    const parsed = GuestSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `    ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      problems.push(`  content/guests/${key}.json\n${detail}`);
      continue;
    }
    if (parsed.data.slug !== key) {
      problems.push(`  content/guests/${key}.json\n    slug: expected "${key}", found "${parsed.data.slug}"`);
      continue;
    }
    out.set(parsed.data.slug, parsed.data);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid guest content:\n${problems.join('\n')}`);
  }
  return out;
}

const GUESTS = loadAll();

export function allGuests(): Guest[] {
  return [...GUESTS.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function getGuest(slug: string): Guest | null {
  return GUESTS.get(slug) ?? null;
}

export function guestSlugs(): string[] {
  return [...GUESTS.keys()];
}

/** Total seats across every live guest page — the number the venue asks for. */
export function seatCount(): number {
  return allGuests()
    .filter((g) => g.status === 'live')
    .reduce((n, g) => n + g.party.length, 0);
}

export type { Guest };
