import { z } from 'zod';

/**
 * The shape of a per-guest microsite. One JSON file per guest (or household)
 * in content/guests/. Everything here is safe to render; keep anything you
 * would not want a guest to read in `privateNotes`, which is never sent to
 * the browser on a guest page.
 */

const MenuOption = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  /** Marks an option as a joke so the admin view can flag it. Purely cosmetic. */
  tongueInCheek: z.boolean().optional(),
});

const MenuCourse = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  note: z.string().optional(),
  /** Each named person in the party picks one option per course. */
  options: z.array(MenuOption).min(1),
});

const PartyMember = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** e.g. "child", "plus one" — shown as a small tag. */
  tag: z.string().optional(),
  /** Skip the menu for this person (babies, evening-only guests). */
  skipMenu: z.boolean().optional(),
});

const Section = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('note'),
    title: z.string(),
    body: z.string(),
  }),
  z.object({
    type: z.literal('list'),
    title: z.string(),
    intro: z.string().optional(),
    items: z.array(z.string()).min(1),
  }),
  z.object({
    type: z.literal('quote'),
    body: z.string(),
    attribution: z.string().optional(),
  }),
  z.object({
    type: z.literal('facts'),
    title: z.string(),
    facts: z.array(z.object({ label: z.string(), value: z.string() })).min(1),
  }),
  z.object({
    type: z.literal('image'),
    /** Path under /public, e.g. "/guests/dave.jpg", or an absolute URL. */
    src: z.string(),
    alt: z.string(),
    caption: z.string().optional(),
  }),
]);

export const GuestSchema = z.object({
  /** URL segment: /g/<slug>. Lowercase, hyphenated, stable — links are shared. */
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase-hyphenated'),

  /**
   * draft  — 404s for guests; visible to you with ?preview=1 while signed in as admin.
   * live   — reachable with a valid personal link.
   * closed — politely tells the guest the site is closed (post-wedding).
   */
  status: z.enum(['draft', 'live', 'closed']).default('draft'),

  /** How you greet them. "Dave", "The Shahs", "Nan". */
  displayName: z.string().min(1),

  hero: z.object({
    kicker: z.string().optional(),
    headline: z.string().min(1),
    blurb: z.string().optional(),
  }),

  /** Everyone with a seat. Drives the RSVP form. */
  party: z.array(PartyMember).min(1),

  /** Which parts of the day they are invited to. Keys match schedule `requires`. */
  invitedTo: z.array(z.string()).default(['ceremony', 'reception']),

  /** Per-guest menu. Omit entirely for evening-only guests. */
  menu: z
    .object({
      intro: z.string().optional(),
      courses: z.array(MenuCourse).min(1),
    })
    .optional(),

  /** Freeform blocks rendered in order, below the RSVP. This is where the fun goes. */
  sections: z.array(Section).default([]),

  /** Extra Q&A shown only to this guest, above the global FAQ. */
  faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),

  /** Deadline override for this guest, ISO date. Falls back to the global one. */
  rsvpDeadline: z.string().optional(),

  /**
   * Overrides the derived access code. Leave unset in almost every case —
   * codes are derived from GUEST_LINK_SECRET so they are not stored in git.
   */
  accessCode: z.string().min(4).optional(),

  /** Never rendered on the guest page. Visible in the admin dashboard only. */
  privateNotes: z.string().optional(),

  /** Admin-only: where they sit, dietary notes you already know, etc. */
  adminMeta: z.record(z.string()).default({}),
});

export type Guest = z.infer<typeof GuestSchema>;
export type GuestMenu = NonNullable<Guest['menu']>;
export type GuestSection = z.infer<typeof Section>;
export type GuestPartyMember = z.infer<typeof PartyMember>;

/** The guest object with admin-only fields stripped, for sending to the browser. */
export type PublicGuest = Omit<Guest, 'privateNotes' | 'adminMeta' | 'accessCode'>;

export function toPublicGuest(guest: Guest): PublicGuest {
  const { privateNotes: _p, adminMeta: _a, accessCode: _c, ...rest } = guest;
  return rest;
}
