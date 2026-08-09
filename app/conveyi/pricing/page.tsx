import type { Metadata } from 'next';
import { ctaHref, ROUTES, Cta, NavHeader, SiteFooter } from '../../_components/shared';

export const metadata: Metadata = {
  title: 'Pricing — CONVEYi',
  description:
    'Simple pricing for CONVEYi. Go £199, Pro £399, Firm £1,000 with 3 seats included. 30-day money-back guarantee. No lock-in. Earn £50/month recurring for every firm you refer.',
};

const PAGE_SOURCE = 'pricing';

const tiers = [
  {
    name: 'Go',
    price: '£199',
    seats: 'One seat',
    blurb: 'The whole product, on a meter. For the conveyancer who wants to see what it does to their week.',
    features: [
      'CONVEYi add-in inside Outlook',
      'Thread summaries & case-aware draft replies',
      'Auto-triage incoming mail, matched to the right case',
      'Auto-rules: file, tag & draft on routine updates',
      'AI document packs — a taste, not a workhorse',
      'Per-case OneDrive knowledge base & live Excel tracker',
      'Monthly limits on email volume and AI documents',
    ],
    cta: 'pricing_go',
    highlight: false,
  },
  {
    name: 'Pro',
    price: '£399',
    seats: 'One seat',
    blurb: 'The same tools with room to actually work. For the sole practitioner running a full caseload.',
    features: [
      'Everything in Go',
      'Unlimited email volume',
      'Far higher AI document allowance',
      'Unlimited onboarding lookback',
      'Priority drafting queue',
    ],
    cta: 'pricing_pro',
    highlight: false,
  },
  {
    name: 'Firm',
    price: '£1,000',
    seats: '3 seats included · £59/seat after',
    blurb: 'For the practice that runs its cases as a team — and the only plan with more than one seat.',
    features: [
      'Everything in Pro, uncapped',
      'Team seats — the only multi-seat plan',
      'Matter board — every live case by stage',
      'Workload dashboard — who’s carrying what',
      'Assign matters & chases across the team',
      'Team roles & admin oversight',
      'Priority support',
    ],
    cta: 'pricing_firm',
    highlight: true,
  },
];

export default function PricingPage() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      <section className="px-6 pt-16 pb-8 md:pt-24">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">Pricing</p>
          <h1 className="mt-4 font-serif text-5xl font-semibold leading-tight tracking-tight md:text-6xl">
            Priced per firm. Not per headache.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink-soft">
            No setup fees, no annual lock-in. Every plan has the full product — the difference is
            how much of it you can use, and whether your team comes with you. Try it for 30 days;
            if it doesn’t save you time, get your money back.
          </p>
        </div>
      </section>

      <section className="px-6 py-12 md:py-16">
        <div className="mx-auto grid max-w-6xl gap-6 md:grid-cols-3">
          {tiers.map((t) => (
            <div
              key={t.name}
              className={`relative rounded-3xl p-8 md:p-9 ${
                t.highlight ? 'border-2 border-violet bg-paper-soft shadow-violet' : 'border border-line bg-paper-soft'
              }`}
            >
              {t.highlight && (
                <span className="absolute -top-3 left-8 rounded-full bg-violet px-3 py-1 text-xs font-bold uppercase tracking-wider text-white">
                  For teams
                </span>
              )}
              <h2 className="text-lg font-bold uppercase tracking-widest text-ink-soft">{t.name}</h2>
              <div className="mt-3 flex items-end gap-2">
                <span className="font-serif text-6xl font-semibold">{t.price}</span>
                <span className="mb-2 text-ink-soft">/month</span>
              </div>
              <p className="mt-2 text-sm font-semibold text-violet">{t.seats}</p>
              <p className="mt-3 text-ink-soft">{t.blurb}</p>
              <ul className="mt-7 space-y-3">
                {t.features.map((f) => (
                  <li key={f} className="flex gap-3 text-ink">
                    <span className="mt-1 shrink-0 font-bold text-violet">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-8">
                <Cta
                  label="Get started"
                  href={ctaHref(ROUTES.signup, PAGE_SOURCE, t.cta)}
                  dataCta={t.cta}
                  variant={t.highlight ? 'primary' : 'secondary'}
                  size="lg"
                  className="w-full"
                />
              </div>
            </div>
          ))}
        </div>

        <div className="mx-auto mt-10 max-w-6xl rounded-2xl border border-violet/20 bg-violet-soft p-6 text-center md:p-8">
          <p className="font-serif text-2xl font-semibold tracking-tight">
            Earn it back: <span className="text-violet">up to £50/month recurring</span> for every firm you refer.
          </p>
          <p className="mt-2 text-ink-soft">A quarter of what each firm you refer pays, up to £50 a month — as account credit, for as long as they stay a customer. A few referrals and your own subscription pays for itself.</p>
        </div>

        <p className="mx-auto mt-8 max-w-6xl text-center text-sm text-ink-soft">
          All plans include the 30-day money-back guarantee. ·{' '}
          <a href={ctaHref(ROUTES.faq, PAGE_SOURCE, 'pricing_faq')} className="text-violet underline underline-offset-4">Read the FAQ</a>
        </p>
      </section>

      <section className="bg-ink px-6 py-20 text-paper md:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-serif text-4xl font-semibold tracking-tight md:text-5xl">Start solo. Grow into the firm.</h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-paper/70">Move up to Pro the moment you want the routine automated — and open it to your whole team when you’re ready.</p>
          <div className="mt-8 flex justify-center">
            <Cta label="Get started" href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'cta_signup')} dataCta="cta_signup" size="lg" />
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
