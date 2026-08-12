import type { Metadata } from 'next';
import {
  ctaHref,
  ROUTES,
  Cta,
  NavHeader,
  SiteFooter,
  APPSOURCE_URL,
} from '../_components/shared';
import { PanelCarousel } from '../_components/PanelCarousel';

export const metadata: Metadata = {
  title: 'CONVEYi — AI for conveyancers. Inside Outlook. | Case Lightning',
  description:
    '99% of conveyancing is email, updates and chasing. CONVEYi handles it — inside Outlook, on your OneDrive, in your Excel tracker. GDPR-compliant. Zero onboarding. A Case Lightning product.',
};

const PAGE_SOURCE = 'landing';

// The five panels from the Microsoft Marketplace listing, reused so the site and the store
// tell one story. NB these are ILLUSTRATIONS of the pane, not captures of the running app,
// and each already carries its own headline and body copy baked into the artwork — so they
// get no visible caption here (it would duplicate the image) but they do need real alt text,
// because everything written on them is invisible to a screen reader.
const panels: Array<{ src: string; alt: string }> = [
  {
    src: '/product/pane-1.png',
    alt: 'The CONVEYi pane beside an email: the thread has been matched to matter SMITH-X at 12 Oak Lane, tagged “Reply needed”, with a summary of what the sender is asking for and a Draft reply button.',
  },
  {
    src: '/product/pane-2.png',
    alt: 'A drafted reply in the pane with Neutral, Firm and Chasing tone options, confirming receipt of the draft contract and enclosing the EPC and TA10 form. A note reads “Saved to your Outlook Drafts — review and send there.”',
  },
  {
    src: '/product/pane-3.png',
    alt: 'A list of live matters — SMITH-X, JONES-P, PATEL-K, OKAFOR-D — each showing its stage, how long it has sat there as a coloured age dot, and what is outstanding, including one marked “Chase needed”.',
  },
  {
    src: '/product/pane-4.png',
    alt: 'Document generation in the pane: a client care letter template filled from the matter file with the property, price and completion terms highlighted, noting six fields filled from the matter.',
  },
  {
    src: '/product/pane-5.png',
    alt: 'The matter’s files in the firm’s own OneDrive — a live Excel tracker plus the draft contract, EPC and TA10 form filed from email, and a generated client care letter.',
  },
];

// Install → find → pin → sign in. Outlook hides add-ins behind the Apps button and opens
// the pane unpinned, so it closes the moment you open the next email — the single most
// common reason a new install looks broken. Spelling it out here, on the store listing and
// in the pane's own tour is deliberate belt-and-braces.
const firstRun = [
  {
    name: 'Install it',
    body: 'Or in Outlook: Apps → Get add-ins → search CONVEYi. Nothing downloads to your machine.',
    href: APPSOURCE_URL,
    linkLabel: 'Get it on Microsoft AppSource',
  },
  {
    name: 'Open an email',
    body: 'Any client email, in Outlook on Windows, Mac or the web. CONVEYi works on the message you are reading.',
  },
  {
    name: 'Find it under Apps',
    body: 'Click the Apps button in the email’s toolbar (the ⋯ more menu on some versions), then choose CONVEYi.',
  },
  {
    name: 'Pin the pane',
    body: 'Click the 📌 pin at the top of the pane. Without this it closes every time you open a different email.',
  },
  {
    name: 'Sign in once',
    body: 'Sign in with the same Microsoft 365 account. From then on the pane follows you from email to email.',
  },
];

// The three objections every firm raises before they'll try it: is our data safe, how much
// upheaval is this, and can it email a client without us. Answered directly under the hero
// rather than three-quarters down the page, because an unanswered objection is where the
// visitor leaves.
const proof: Array<{ icon: IconName; title: string; body: string }> = [
  {
    icon: 'shield',
    title: 'GDPR-compliant by design',
    body: 'Your data never leaves your own Microsoft 365 tenant. We don’t copy your files to a third-party portal.',
  },
  {
    icon: 'bolt',
    title: 'Zero onboarding',
    body: 'No migration, no new logins, no training day. If your team can use Outlook, they can use this today.',
  },
  {
    icon: 'draft',
    title: 'Draft-only, always',
    body: 'Nothing is sent without a human. Every reply lands in your Drafts for you to check and send.',
  },
];

type IconName = 'shield' | 'bolt' | 'draft';

// Hand-rolled rather than pulling in an icon package for three glyphs — the site already
// draws its own SVG (see the wordmark and the carousel arrows). Stroked, currentColor, so they
// inherit the brand violet and stay crisp at any size.
const ICON_PATHS: Record<IconName, React.ReactNode> = {
  shield: (
    <>
      <path d="M12 3l7 3v5.2c0 4.4-2.9 8-7 9.8-4.1-1.8-7-5.4-7-9.8V6l7-3z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  bolt: <path d="M13 2 4.5 13.5H11l-1 8.5L19 10.5h-6.5L13 2z" />,
  draft: (
    <>
      <path d="M12.5 20H21" />
      <path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5L16.4 3.6z" />
    </>
  ),
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-6 w-6"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

export default function Page() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      {/* ── HERO ── */}
      <section className="px-6 pt-16 pb-20 md:pt-24 md:pb-28">
        <div className="mx-auto max-w-4xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">
            AI for conveyancers · inside Outlook
          </p>
          <h1 className="mt-5 font-serif text-5xl font-semibold leading-[1.02] tracking-tight md:text-7xl">
            The world still runs on email.
            <span className="block italic text-violet">So do we.</span>
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-relaxed text-ink-soft md:text-xl">
            Double your transaction output without leaving your inbox.
          </p>
          <div className="mt-9 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <Cta label="Get started" href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'hero_signup')} dataCta="hero_signup" size="lg" />
            <Cta label="See how it works" href={ctaHref(ROUTES.howItWorks, PAGE_SOURCE, 'hero_how')} dataCta="hero_how" variant="secondary" size="lg" />
            <Cta label="Get it on AppSource" href={APPSOURCE_URL} dataCta="hero_appsource" variant="ghost" size="lg" />
          </div>
          <p className="mt-5 text-sm text-ink-soft">
            From £200/month · 30-day money-back guarantee · nothing to download
          </p>
        </div>
      </section>

      {/* ── PROOF / TRUST ── Directly under the hero: these are the objections, and they
           should be answered before the pitch continues, not after it. */}
      <section className="border-y border-line bg-paper-soft px-6 py-14 md:py-16">
        <div className="mx-auto grid max-w-6xl gap-10 md:grid-cols-3">
          {proof.map((p) => (
            <div key={p.title} className="flex flex-col items-center text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet/10 text-violet">
                <Icon name={p.icon} />
              </div>
              <h3 className="mt-4 font-serif text-2xl font-semibold tracking-tight">{p.title}</h3>
              <p className="mt-2 max-w-xs text-ink-soft">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── WHAT IT LOOKS LIKE ── No heading: each panel carries its own headline and
           copy in the artwork, so a section title would only say it a second time. */}
      <section className="border-t border-line bg-paper-soft px-6 py-20 md:py-24">
        <div className="mx-auto max-w-5xl">
          <PanelCarousel panels={panels} />
        </div>
      </section>

      {/* ── INSTALL & FIRST RUN ── */}
      <section className="border-t border-line bg-paper-soft px-6 py-20 md:py-24">
        <div className="mx-auto max-w-6xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">Installing &amp; getting started</p>
          <h2 className="mt-4 max-w-2xl font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            Set it up once. Then it’s just there.
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-ink-soft">
            There’s nothing to download. Outlook tucks new add-ins behind the{' '}
            <strong className="font-semibold text-ink">Apps</strong> button and opens them unpinned — so the pane
            closes each time you move to another email until you pin it. Here’s the whole setup, start to finish.
          </p>
          {/* A vertical list, not a grid: five steps never divide evenly into a card grid,
              and a sequence reads better stacked than wrapped across rows anyway. */}
          <ol className="mt-12 max-w-3xl divide-y divide-line overflow-hidden rounded-2xl border border-line bg-paper">
            {firstRun.map((s, i) => (
              <li key={s.name} className="flex gap-5 p-6 md:gap-6 md:p-7">
                <span className="shrink-0 font-serif text-2xl font-semibold leading-none text-violet md:text-3xl">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold leading-tight">{s.name}</h3>
                  <p className="mt-2 text-ink-soft">
                    {'href' in s && s.href && (
                      <>
                        <a
                          href={s.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-cta="firstrun_appsource"
                          className="font-semibold text-violet underline underline-offset-4 decoration-violet/40 hover:decoration-violet"
                        >
                          {s.linkLabel}
                        </a>
                        {' — '}
                      </>
                    )}
                    {s.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-6 text-sm text-ink-soft">
            Miss the pin and CONVEYi still works — you’ll just have to reopen it from Apps each time. The add-in
            shows you where it is the first time you open it.
          </p>
        </div>
      </section>

      {/* ── REFERRAL ── */}
      <section className="px-6 py-20 md:py-28">
        <div className="mx-auto max-w-4xl rounded-3xl border border-violet/20 bg-violet-soft p-10 md:p-14">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">The best referral scheme in legal software</p>
          <h2 className="mt-4 font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            Refer a firm, earn <span className="italic text-violet">£50 every month</span> they stay.
          </h2>
          <p className="mt-5 max-w-2xl text-lg text-ink-soft">
            Not a one-off finder’s fee — a recurring £50/month in account credit for every firm you refer,
            for as long as they’re a customer. Refer a handful and your own subscription pays for itself.
          </p>
        </div>
      </section>

      {/* ── PRICING TEASER ── */}
      <section className="border-t border-line px-6 py-20 md:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
            <h2 className="font-serif text-4xl font-semibold tracking-tight md:text-5xl">Three plans. No lock-in.</h2>
            <Cta label="See full pricing" href={ctaHref(ROUTES.pricing, PAGE_SOURCE, 'pricing_teaser')} dataCta="pricing_teaser" variant="ghost" />
          </div>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            <div className="rounded-2xl border border-line bg-paper-soft p-8">
              <div className="text-sm font-semibold uppercase tracking-widest text-ink-soft">Go</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£200<span className="text-lg font-sans font-normal text-ink-soft">/mo</span></div>
              <p className="mt-3 text-ink-soft">The whole product on a meter — auto-triage, auto-rules and AI drafting, with monthly limits.</p>
            </div>
            <div className="rounded-2xl border border-line bg-paper-soft p-8">
              <div className="text-sm font-semibold uppercase tracking-widest text-ink-soft">Pro</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£500<span className="text-lg font-sans font-normal text-ink-soft">/mo</span></div>
              <p className="mt-3 text-ink-soft">The same tools with the limits taken off — unlimited email volume and a far bigger AI document allowance.</p>
            </div>
            <div className="rounded-2xl border-2 border-violet bg-paper-soft p-8 shadow-violet">
              <div className="text-sm font-semibold uppercase tracking-widest text-violet">Firm</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£1,000<span className="text-lg font-sans font-normal text-ink-soft">/mo</span></div>
              <p className="mt-3 text-ink-soft">The whole practice as a team — matter board, workload and assignment. The only multi-seat plan; 3 seats included.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="bg-ink px-6 py-20 text-paper md:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-serif text-4xl font-semibold leading-tight tracking-tight md:text-6xl">
            Handle more cases this month.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-paper/70">
            Same team. Same Outlook. Far less admin. Try it for 30 days — if it doesn’t save you time, get your money back.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta label="Get started" href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'footer_signup')} dataCta="footer_signup" size="lg" />
            <Cta label="See pricing" href={ctaHref(ROUTES.pricing, PAGE_SOURCE, 'footer_pricing')} dataCta="footer_pricing" variant="secondary" size="lg" className="border-paper/30 text-paper hover:bg-paper hover:text-ink" />
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
