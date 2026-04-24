import {
  ctaHref,
  ROUTES,
  SectionBackground,
  HERO_BG,
  Cta,
  NavHeader,
  SiteFooter,
} from './_components/shared';

const PAGE_SOURCE = 'landing';

const testimonials = [
  {
    quote:
      'We now bill more work in the same hours. CaseLightning cut the time we spend chasing context so our fee earners spend more of the day on billable work.',
    author: 'Sarah M.',
    role: 'Practice Manager, conveyancing firm',
  },
  {
    quote:
      'Client updates that used to take 20 minutes now take 3. CaseLightning paid for itself in the first week.',
    author: 'James T.',
    role: 'Solicitor, property law practice',
  },
  {
    quote:
      "We were sceptical, but the no-fuss setup and the money-back guarantee made us try it. Now I can't imagine going back.",
    author: 'Rachel P.',
    role: 'Director, family law firm',
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Page() {
  return (
    <main className="bg-slate-950 text-white antialiased">

      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      {/* ── HERO ── */}
      <section className="relative overflow-hidden bg-slate-950 px-6 pb-24 pt-20 md:pb-32 md:pt-28">
        <div className="pointer-events-none absolute inset-0 flex items-start justify-center">
          <div
            aria-hidden="true"
            className="h-[600px] w-[800px] -translate-y-1/3 rounded-full bg-brand-500 opacity-[0.06] blur-3xl"
          />
        </div>
        <SectionBackground positions={HERO_BG} />

        <div className="relative mx-auto max-w-4xl text-center">
          {/* 5-star rating badge */}
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-slate-700/80 bg-slate-900/80 px-4 py-1.5 text-sm text-slate-300 shadow-[0_2px_12px_rgba(0,0,0,0.4)]">
            <span className="flex gap-0.5 text-yellow-400 text-base leading-none">★★★★★</span>
            <span>Rated 5/5 by 50+ legal teams</span>
          </div>

          <h1 className="text-4xl font-extrabold leading-tight tracking-tight md:text-6xl">
            10X More Cases.
            <br className="hidden sm:block" />
            <span className="text-brand-500"> Without Leaving Outlook.</span>
            <br className="hidden sm:block" />
            Or your money back.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400">
            CaseLightning gives every fee earner instant case insight — clear summaries, fast next actions, and confident client replies — all from inside Outlook.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta
              label="Sign Up"
              href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'hero_signup')}
              dataCta="hero_signup"
              size="lg"
            />
            <Cta
              label="See How It Works"
              href={ctaHref(ROUTES.howItWorks, PAGE_SOURCE, 'hero_how_it_works')}
              dataCta="hero_how_it_works"
              variant="secondary"
              size="lg"
            />
          </div>
        </div>
      </section>

      {/* ── TESTIMONIALS ── */}
      <section className="relative overflow-hidden bg-slate-900 px-6 py-16 md:py-24">
        <SectionBackground />
        <div className="relative mx-auto max-w-6xl">
          <h2 className="text-3xl font-bold md:text-4xl">What firms are saying</h2>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {testimonials.map((t) => (
              <article
                key={t.author}
                className="rounded-2xl border border-slate-700/60 bg-slate-950/80 p-6 shadow-[0_4px_24px_rgba(0,0,0,0.45)]"
              >
                <div className="mb-3 flex gap-0.5 text-sm text-yellow-400">★★★★★</div>
                <p className="text-3xl font-extrabold leading-none text-brand-pink">&ldquo;</p>
                <p className="mt-2 text-slate-300">{t.quote}</p>
                <div className="mt-4 border-t border-slate-800 pt-4">
                  <p className="font-semibold text-white">{t.author}</p>
                  <p className="text-sm text-slate-500">{t.role}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="relative overflow-hidden bg-slate-950 px-6 py-16 md:py-24">
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            aria-hidden="true"
            className="h-[400px] w-[600px] rounded-full bg-brand-pink opacity-[0.07] blur-3xl"
          />
        </div>
        <SectionBackground />
        <div className="relative mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-extrabold md:text-5xl">
            Start handling more cases this month
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-slate-400">
            Reply faster, cut admin, keep clients happier — without adding headcount.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta
              label="Sign Up"
              href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'footer_signup')}
              dataCta="footer_signup"
              size="lg"
            />
            <Cta
              label="See Pricing"
              href={ctaHref(ROUTES.pricing, PAGE_SOURCE, 'footer_pricing')}
              dataCta="footer_pricing"
              variant="secondary"
              size="lg"
            />
          </div>
          <p className="mt-6 text-sm text-slate-500">
            From £200/month &nbsp;·&nbsp; Money-back guarantee &nbsp;·&nbsp; No complicated setup
          </p>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
