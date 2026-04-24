import type { Metadata } from 'next';
import {
  ctaHref,
  ROUTES,
  SectionBackground,
  Cta,
  NavHeader,
  SiteFooter,
} from '../_components/shared';

export const metadata: Metadata = {
  title: 'Pricing — CaseLightning',
  description:
    'Simple, transparent pricing for CaseLightning. From £200/month for small law firms and conveyancers. Money-back guarantee included.',
};

const PAGE_SOURCE = 'pricing';

const pricingTiers = [
  {
    name: 'Starter',
    price: '£200',
    period: 'per month',
    description: 'Perfect for small teams ready to move faster on every case.',
    features: [
      'Up to 5 users',
      'Unlimited cases',
      'Works inside Outlook',
      'Clear case summaries on demand',
      'Fast next-action suggestions',
      'Money-back guarantee',
    ],
    ctaContent: 'pricing_starter_signup',
    highlight: false,
  },
  {
    name: 'Full Team',
    price: '£499',
    period: 'per month',
    description: 'For growing firms that want firm-wide efficiency and automation.',
    features: [
      'Unlimited users',
      'Everything in Starter',
      'Automation rules engine',
      'Custom case workflows',
      'Team analytics dashboard',
      'Priority support',
    ],
    ctaContent: 'pricing_team_signup',
    highlight: true,
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────
export default function PricingPage() {
  return (
    <main className="bg-slate-950 text-white antialiased">

      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      {/* ── HERO ── */}
      <section className="relative overflow-hidden bg-slate-950 px-6 pb-8 pt-16 md:pt-24">
        <div className="pointer-events-none absolute inset-0 flex items-start justify-center">
          <div
            aria-hidden="true"
            className="h-[400px] w-[700px] -translate-y-1/3 rounded-full bg-brand-500 opacity-[0.05] blur-3xl"
          />
        </div>
        <div className="relative mx-auto max-w-3xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-slate-400">
            Simple, transparent pricing
          </p>
          <h1 className="mt-3 text-4xl font-extrabold leading-tight tracking-tight md:text-5xl">
            Choose your plan
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-slate-400">
            No hidden fees. No annual lock-in. If it doesn't save you time, don't keep it.
          </p>
        </div>
      </section>

      {/* ── PRICING TIERS ── */}
      <section className="relative overflow-hidden bg-slate-950 px-6 py-12 md:py-20">
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div aria-hidden="true" className="h-[400px] w-[900px] rounded-full bg-brand-500 opacity-[0.04] blur-3xl" />
        </div>
        <SectionBackground />
        <div className="relative mx-auto max-w-5xl">
          <div className="grid gap-6 md:grid-cols-2">
            {pricingTiers.map((tier) => (
              <div
                key={tier.name}
                className={`relative rounded-3xl p-8 shadow-[0_8px_40px_rgba(0,0,0,0.55)] transition duration-200 ${
                  tier.highlight
                    ? 'border-2 border-brand-pink bg-slate-900 shadow-glow-pink'
                    : 'border border-slate-700/60 bg-slate-900 hover:border-slate-500'
                }`}
              >
                {tier.highlight && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                    <span className="rounded-full bg-brand-pink px-4 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-glow-pink">
                      Most Popular
                    </span>
                  </div>
                )}
                <h2 className="text-xl font-bold text-white">{tier.name}</h2>
                <p className="mt-1 text-sm text-slate-400">{tier.description}</p>
                <div className="mt-4 flex items-end gap-2">
                  <span className={`text-5xl font-extrabold ${tier.highlight ? 'text-brand-pink' : 'text-brand-500'}`}>
                    {tier.price}
                  </span>
                  <span className="mb-1 text-lg text-slate-400">{tier.period}</span>
                </div>
                <ul className="mt-6 space-y-2.5">
                  {tier.features.map((item) => (
                    <li key={item} className="flex items-center gap-2.5 text-slate-200">
                      <span className={`shrink-0 font-bold ${tier.highlight ? 'text-brand-pink' : 'text-brand-500'}`}>✓</span>
                      {item}
                    </li>
                  ))}
                </ul>
                <p className="mt-6 text-sm font-semibold text-slate-400">
                  If it doesn&apos;t save you time, don&apos;t keep it.
                </p>
                <div className="mt-6">
                  <Cta
                    label="Sign Up"
                    href={ctaHref(ROUTES.signup, PAGE_SOURCE, tier.ctaContent)}
                    dataCta={tier.ctaContent}
                    variant={tier.highlight ? 'primary' : 'secondary'}
                    size="lg"
                    className="w-full justify-center"
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Money-back guarantee note */}
          <p className="mt-10 text-center text-sm text-slate-500">
            All plans include our money-back guarantee. &nbsp;·&nbsp;{' '}
            <a href={ctaHref(ROUTES.faq, PAGE_SOURCE, 'pricing_faq_link')} className="text-brand-blue hover:underline">
              Read our FAQ
            </a>
          </p>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="relative overflow-hidden bg-slate-900 px-6 py-16 md:py-24">
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            aria-hidden="true"
            className="h-[400px] w-[600px] rounded-full bg-brand-pink opacity-[0.07] blur-3xl"
          />
        </div>
        <SectionBackground />
        <div className="relative mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-extrabold md:text-4xl">
            Not sure which plan is right for you?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-slate-400">
            Both plans are covered by our money-back guarantee. Start with Starter and upgrade any time.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta
              label="Sign Up"
              href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'cta_signup')}
              dataCta="cta_signup"
              size="lg"
            />
            <Cta
              label="See How It Works"
              href={ctaHref(ROUTES.howItWorks, PAGE_SOURCE, 'cta_how_it_works')}
              dataCta="cta_how_it_works"
              variant="secondary"
              size="lg"
            />
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
