# Wedding website

A private wedding site with a password-gated public half and a **personal
microsite for every guest** — their own copy, their own menu (jokes included),
their own RSVP. Registries are deliberately not built here; they are links out
to people who do that professionally.

- **Landing site** — one shared password, then the day, travel, gifts, FAQ.
- **Guest microsites** at `/g/<slug>` — opened by a personal link, not the
  shared password. Each one is a JSON file you edit and commit.
- **Back of house** at `/admin` — who has opened their page, who has replied,
  what everyone chose to eat, a CSV for the caterer, and a preview-as-guest
  button so you can test a page before anyone sees it.

Next.js (App Router) + TypeScript + Tailwind. Deploys to Vercel.

---

## Getting started

```bash
npm install
cp .env.example .env.local     # then fill it in — see below
npm run dev                    # http://localhost:3000
```

Development works with no configuration at all: unset secrets fall back to
insecure defaults (`letmein` / `admin`) with a warning in the console. In
production the app refuses to start until they are set properly.

```bash
npm run guests:links           # every guest's personal link
```

Open one of those links and you are that guest. Go to `/admin` and you are you.

---

## Adding a guest

```bash
npm run guests:new -- "The Shahs"
```

That copies `content/guests/_template.json` to `content/guests/the-shahs.json`
as a **draft** and regenerates the index. Then:

1. Edit the file — party, menu, sections, private notes.
2. Preview it at `/admin/g/the-shahs` → **Preview their page**. Drafts are
   invisible to guests but fully previewable by you.
3. Change `"status"` to `"live"`.
4. `npm run guests:links` → send them their link.

Run `npm run guests:check` before you deploy. It validates every file against
the schema and fails if `content/guests/index.ts` has drifted; `-- --fix`
regenerates it.

### What goes in a guest file

| Field | What it does |
| --- | --- |
| `slug` | The URL: `/g/<slug>`. Must match the filename. Never change it after sending links. |
| `status` | `draft` (only you can see it) · `live` · `closed` (a thank-you message instead) |
| `displayName` | How you address them — `"Dave"`, `"The Shahs"`, `"Nan"` |
| `hero` | `kicker`, `headline`, `blurb` — the top of their page |
| `party` | Everyone with a seat. Drives the RSVP form. `skipMenu: true` for evening-only or babies. |
| `invitedTo` | Which parts of the day they get. Also filters the shared schedule page. |
| `menu` | Their own courses and options. `tongueInCheek: true` flags a joke in the admin view. |
| `sections` | Freeform blocks under the RSVP: `note`, `list`, `quote`, `facts`, `image` |
| `faq` | Extra Q&A shown only to them, above the shared FAQ |
| `privateNotes`, `adminMeta` | **Never rendered on their page.** Admin dashboard only. |

`content/guests/dave-collins.json` is the worked example of taking the piss;
`nan.json` is the same machinery used gently. Both are meant to be deleted.

A guest only sees their menu once they mark someone as **Coming** — the joke
options are the reward for saying yes.

---

## How access works

Three cookies, all signed with `SESSION_SECRET`:

| Session | How you get it | What it opens |
| --- | --- | --- |
| `site` | The shared password at `/login` | The public pages |
| `guest` | A valid personal link | That guest's page **and** the public pages |
| `admin` | The admin password at `/admin/login` | `/admin`, plus preview of drafts |

Personal codes are **derived**, not stored: `HMAC(GUEST_LINK_SECRET, slug)`,
eight characters from a vowel-free alphabet. So no personal link is ever
committed to git, and the same slug always produces the same link. Rotating
`GUEST_LINK_SECRET` invalidates every link at once — do that before you send
them, not after.

A personal link is a bearer token in a URL. It is a wedding, not a bank: the
tradeoff is deliberate, and the blast radius of a forwarded link is one guest's
menu. The code is swapped for a cookie on arrival and dropped from the URL, so
it stops travelling in history and referrers.

Everything is `noindex`, and `middleware.ts` gates every route by default —
a new page is private unless you explicitly open it.

---

## Monitoring

`/admin` shows, per guest: status, seats, whether they have replied, when they
last opened their page, and their personal link with a copy button.
`/admin/g/<slug>` adds their answers with menu labels resolved, dietary notes,
your private notes, and a visit log.

Visits are recorded first-party only — no analytics service, no third-party
script. Your own admin previews are deliberately **not** counted, so
"has Dave looked at it yet?" stays an honest question.

`/admin/export` is the CSV the caterer and venue actually want: one row per
person, one column per course.

---

## Storage

| `DATABASE_URL` | Driver | Use |
| --- | --- | --- |
| unset | `.data/store.json` | Local development. Zero setup. |
| set | Postgres | Production. Run `npm run migrate` once. |

Both implement the same interface in `lib/store/types.ts`.

**The file store is not viable on Vercel** — serverless filesystems are
per-instance and discarded, so RSVPs written there vanish silently. Set
`DATABASE_URL` before you send a single link. The admin footer always shows
which driver is live.

---

## Deploying to Vercel

1. Import the repo. Framework preset: Next.js. No build overrides needed.
2. Set `SESSION_SECRET`, `GUEST_LINK_SECRET`, `SITE_PASSWORD`, `ADMIN_PASSWORD`
   and `DATABASE_URL` (Vercel Postgres, Neon, Supabase — anything Postgres).
3. `npm run migrate` once against that database.
4. Set `NEXT_PUBLIC_SITE_URL` if you are on a custom domain, so
   `guests:links` prints the right host.
5. Deploy, then `npm run guests:links` and start sending.

---

## Testing

```bash
npx playwright install chromium   # first time only
npm test
```

23 end-to-end tests covering the things that would actually be embarrassing:
the password gate, one guest being unable to read another's page, drafts
staying invisible, menu options being validated server-side against that
guest's own menu, and admin previews not polluting visit counts.

The suite blocks all third-party requests, so it never depends on a CDN.
If your sandbox ships its own Chromium, point at it with
`PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome`.

---

## Layout

```
app/
  page.tsx              landing (gated)
  schedule/ travel/ registry/ faq/
  login/                shared password
  g/[slug]/             guest microsite (always dynamic — never prerendered)
  g/[slug]/enter/       swaps ?k=<code> for a cookie
  admin/                dashboard, per-guest detail, CSV export
  api/                  auth, rsvp, track
content/
  wedding.ts            everything shared: date, venue, schedule, FAQ, registry links
  guests/*.json         one file per guest
lib/
  auth.ts               cookies, passwords, derived guest codes
  guest-schema.ts       the zod schema — the contract for a guest file
  store/                file + postgres drivers behind one interface
scripts/                guests:new, guests:check, guests:links, migrate
tests/                  playwright
```

## Things left deliberately undone

- **Registries** are external links only, by design.
- **Email** — nothing is sent. Personal links go out however you like.
  A `resend` integration would slot into `app/api/rsvp/route.ts`.
- **Photos** — `sections` supports images from `/public`; there is no gallery
  or upload flow.
- **Editing guests in the browser** — content is config-as-code on purpose:
  git history is the undo, and a bad edit fails `guests:check` before deploy.
