/**
 * Global site content. Everything public-facing that isn't guest-specific
 * lives here. Edit this file, commit, deploy.
 */

export type ScheduleItem = {
  time: string;
  title: string;
  detail?: string;
  /** Only guests invited to this key see the item. Omit to show it to everyone. */
  requires?: string;
};

export type FaqItem = { q: string; a: string };

export type RegistryLink = {
  name: string;
  href: string;
  blurb: string;
};

export const wedding = {
  /** Shown in the browser tab and on the invitation card. */
  coupleShort: 'A & B',
  partnerOne: 'Alex',
  partnerTwo: 'Sam',

  /** ISO 8601 with offset. Drives the countdown and every rendered date. */
  date: '2027-06-12T13:00:00+01:00',
  dateLabel: 'Saturday 12 June 2027',
  timeLabel: '1:00pm, doors from 12:15pm',

  venue: {
    name: 'The Old Barn',
    addressLines: ['Hollow Lane', 'Little Wickham', 'Oxfordshire OX00 0AA'],
    mapsUrl: 'https://maps.google.com/?q=The+Old+Barn+Oxfordshire',
    what3words: '',
  },

  dressCode: {
    title: 'Dress code',
    body: 'Garden party formal. Heels and grass have never been friends — the ceremony is on a lawn.',
  },

  /** Shown on the landing page under the hero. */
  intro:
    'We are getting married, and we would very much like you there. ' +
    'Everything you need is on this site. If something is missing, it is probably our fault — just ask.',

  schedule: [
    { time: '12:15pm', title: 'Arrival', detail: 'Drinks on the lawn. Please do not be late; there is a lot of lawn.' },
    { time: '1:00pm', title: 'Ceremony', detail: 'Thirty minutes, tops.' },
    { time: '1:45pm', title: 'Photos & drinks', detail: 'You will be in some of them.' },
    { time: '4:00pm', title: 'Dinner', detail: 'The thing you chose a menu for.' },
    { time: '6:30pm', title: 'Speeches', detail: 'Brief. Allegedly.' },
    { time: '7:30pm', title: 'Dancing', detail: 'Until the barn kicks us out.' },
    { time: '11:30pm', title: 'Carriages' },
    { time: '11:00am', title: 'Brunch, the next day', detail: 'Optional. Encouraged.', requires: 'brunch' },
  ] satisfies ScheduleItem[],

  travel: {
    intro: 'Rural Oxfordshire. Plan the last three miles, not the first fifty.',
    options: [
      {
        title: 'By car',
        body: 'Free parking on site. You can leave a car overnight and collect it before 10am on the Sunday.',
      },
      {
        title: 'By train',
        body: 'Nearest station is Wickham Parkway (about 20 minutes by taxi). Book the taxi before you travel — they do not queue up outside.',
      },
      {
        title: 'Staying over',
        body: 'We have held rooms at The Wickham Arms under "Alex & Sam". Release date is eight weeks before.',
      },
    ],
  },

  faq: [
    { q: 'Can I bring a plus one?', a: 'Your personal page lists everyone we have saved a seat for. If a name is missing and you think it should not be, tell us.' },
    { q: 'Are children invited?', a: 'Named children, yes — they will be on your personal page.' },
    { q: 'What about dietary requirements?', a: 'There is a free-text box on your RSVP. Use it. We would rather over-prepare.' },
    { q: 'Is there an evening-only invite?', a: 'Yes for some people. Your personal page will say exactly which bits you are invited to.' },
    { q: 'Can I take photos?', a: 'Everywhere except during the ceremony itself. Put the phone down for thirty minutes.' },
  ] satisfies FaqItem[],

  /**
   * Registries are deliberately external. We link out; we do not rebuild them.
   */
  registry: {
    intro:
      'Your presence is genuinely the point. If you would like to give something anyway, these are run by people far more competent than us.',
    links: [
      { name: 'Prezola', href: 'https://prezola.com/', blurb: 'The main list — homeware, and a honeymoon fund.' },
      { name: 'The John Lewis list', href: 'https://www.johnlewis.com/gift-list', blurb: 'A few larger things, split into shares.' },
    ] satisfies RegistryLink[],
  },

  /**
   * Parts of the day a guest can opt in or out of on their RSVP. The key must
   * match an entry in a guest's `invitedTo`, or it is never shown to them.
   */
  optionalEvents: [
    {
      key: 'brunch',
      label: 'Brunch the next morning',
      detail: '11am at The Wickham Arms. Bacon, coffee, and no obligation whatsoever.',
    },
  ] as { key: string; label: string; detail?: string }[],

  /** RSVP deadline. Individual guests can override this on their own page. */
  rsvpDeadline: '2027-04-10',
  rsvpDeadlineLabel: '10 April 2027',

  contact: {
    email: 'hello@example.com',
    note: 'Reply to any of our messages, or email us. We read everything.',
  },
} as const;

export type Wedding = typeof wedding;
