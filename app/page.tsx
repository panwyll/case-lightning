import type { Metadata } from 'next';
import {
  ctaHref,
  ROUTES,
  Cta,
  NavHeader,
  CaseLightningFooter,
} from './_components/shared';

const PAGE_SOURCE = 'caselightning';

export const metadata: Metadata = {
  title: 'Case Lightning — Case management native to your OS and inbox',
  description:
    'Case management for finance, legal and every document-heavy practice — native to the operating system and email you already use. No new portal. CONVEYi for conveyancing, plus custom builds for your niche.',
};

const NAV_LINKS = [
  { href: '#products', label: 'Products' },
  { href: '#custom', label: 'Custom builds' },
  { href: ROUTES.conveyi, label: 'CONVEYi' },
] as const;

// The umbrella's reason to exist: it lives where the work already happens.
const principles = [
  {
    title: 'Native to your OS',
    body: 'Files live in the storage you already own — OneDrive, your file system, your drives. No data lake to migrate to, no portal to log into.',
  },
  {
    title: 'Native to your inbox',
    body: 'The work is email. Case Lightning reads the thread, drafts the reply and files everything, right inside Outlook — your team never leaves the inbox.',
  },
  {
    title: 'Yours, end to end',
    body: 'Your documents stay in your own tenant. GDPR-compliant by design, fully audited, nothing copied to a third-party system.',
  },
];

// Each niche is a product on the same engine. CONVEYi is live; the rest are
// built to order on the same foundation.
const products = [
  {
    name: 'CONVEYi',
    domain: 'Conveyancing',
    status: 'Live',
    live: true,
    href: ROUTES.conveyi,
    body: 'AI for conveyancers, inside Outlook. Thread summaries, case-aware draft replies, a OneDrive knowledge base and a live Excel tracker per matter.',
  },
  {
    name: 'Finance',
    domain: 'Lending, mortgages & brokerage',
    status: 'In build',
    live: false,
    href: ROUTES.signup,
    body: 'Case management for document-heavy finance work — applications, packaging and client chasing handled in the inbox your team already runs on.',
  },
  {
    name: 'Legal',
    domain: 'Litigation & private client',
    status: 'In build',
    live: false,
    href: ROUTES.signup,
    body: 'Matter management for fee earners who live in email — correspondence, filing and next-action tracking without a new system to learn.',
  },
];

export default function Page() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader
        brand="caselightning"
        homeHref={ROUTES.home}
        links={NAV_LINKS}
        signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')}
      />

      {/* ── HERO ── */}
      <section className="px-6 pt-16 pb-20 md:pt-24 md:pb-28">
        <div className="mx-auto max-w-4xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">
            Case management · native to your OS &amp; inbox
          </p>
          <h1 className="mt-5 font-serif text-5xl font-semibold leading-[1.02] tracking-tight md:text-7xl">
            Your practice runs on email.
            <span className="block italic text-violet">So does your case management.</span>
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-relaxed text-ink-soft md:text-xl">
            Case Lightning builds case management for document-heavy practices — finance, legal,
            conveyancing and beyond — that lives inside the operating system and email you already use.
            No new portal. No migration. Nothing to install.
          </p>
          <div className="mt-9 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <Cta label="See the products" href="#products" dataCta="hero_products" size="lg" />
            <Cta label="Open CONVEYi" href={ROUTES.conveyi} dataCta="hero_conveyi" variant="secondary" size="lg" />
          </div>
          <p className="mt-5 text-sm text-ink-soft">
            CONVEYi is live for conveyancers today · custom builds for other niches
          </p>
        </div>
      </section>

      {/* ── NATIVE PRINCIPLES (ink section for contrast) ── */}
      <section className="bg-ink px-6 py-20 text-paper md:py-28">
        <div className="mx-auto max-w-6xl">
          <h2 className="max-w-2xl font-sans text-4xl font-extrabold leading-tight tracking-tight md:text-6xl">
            We don’t add a system. We work inside yours.
          </h2>
          <p className="mt-5 max-w-2xl text-lg text-paper/70">
            Every other tool asks your team to move their work somewhere new. Case Lightning does the
            opposite — it lives where the work already is.
          </p>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 md:grid-cols-3">
            {principles.map((p, i) => (
              <div key={p.title} className="bg-ink p-8">
                <div className="font-serif text-3xl font-semibold text-[#A78BFA]">{String(i + 1).padStart(2, '0')}</div>
                <h3 className="mt-3 text-xl font-bold">{p.title}</h3>
                <p className="mt-3 text-paper/70">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRODUCTS ── */}
      <section id="products" className="scroll-mt-20 px-6 py-20 md:py-28">
        <div className="mx-auto max-w-6xl">
          <h2 className="max-w-2xl font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            One engine. A product for every niche.
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-ink-soft">
            Each Case Lightning product is the same foundation tuned to a profession — its terminology,
            its files, its workflow. Conveyancing shipped first.
          </p>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {products.map((p) => (
              <a
                key={p.name}
                href={p.href}
                className={`group flex flex-col rounded-2xl border p-8 transition ${
                  p.live
                    ? 'border-violet bg-violet-soft shadow-violet hover:-translate-y-0.5'
                    : 'border-line bg-paper-soft hover:border-ink/20'
                }`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-serif text-2xl font-semibold tracking-tight">{p.name}</h3>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wider ${
                      p.live ? 'bg-violet text-white' : 'bg-ink/5 text-ink-soft'
                    }`}
                  >
                    {p.status}
                  </span>
                </div>
                <div className="mt-1 text-sm font-medium text-ink-soft">{p.domain}</div>
                <p className="mt-4 flex-1 text-ink-soft">{p.body}</p>
                <span className="mt-6 text-sm font-semibold text-violet">
                  {p.live ? 'Explore CONVEYi →' : 'Register interest →'}
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* ── CUSTOM BUILDS ── */}
      <section id="custom" className="scroll-mt-20 border-y border-line bg-paper-soft px-6 py-20 md:py-28">
        <div className="mx-auto grid max-w-6xl items-center gap-12 md:grid-cols-2">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">Custom builds</p>
            <h2 className="mt-4 font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
              Your niche, built to order — on forms, not spreadsheets.
            </h2>
            <p className="mt-5 max-w-xl text-lg text-ink-soft">
              Don’t see your profession yet? We build it. You describe the matter — the parties, the
              fields, the key dates, the documents — and we turn it into a structured case workflow that
              lives in your inbox and your drives. Forms drive the build; the AI does the admin.
            </p>
            <div className="mt-8">
              <Cta label="Talk about a custom build" href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'custom_cta')} dataCta="custom_cta" size="lg" />
            </div>
          </div>
          <div className="rounded-3xl border border-line bg-paper p-8 shadow-card">
            <div className="space-y-4">
              {['Define the matter type and its parties', 'Map the fields, key dates and documents', 'We ship it as a product in your Microsoft 365'].map((step, i) => (
                <div key={step} className="flex gap-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-soft font-serif text-lg font-semibold text-violet">
                    {i + 1}
                  </div>
                  <p className="pt-1 text-ink">{step}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="bg-ink px-6 py-20 text-paper md:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-serif text-4xl font-semibold leading-tight tracking-tight md:text-6xl">
            Case management that meets your team where they work.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-paper/70">
            Start with CONVEYi today, or tell us about your niche and we’ll build it. Either way, nothing
            new to install.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta label="Open CONVEYi" href={ROUTES.conveyi} dataCta="footer_conveyi" size="lg" />
            <Cta label="Register interest" href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'footer_signup')} dataCta="footer_signup" variant="secondary" size="lg" className="border-paper/30 text-paper hover:bg-paper hover:text-ink" />
          </div>
        </div>
      </section>

      <CaseLightningFooter />
    </main>
  );
}
