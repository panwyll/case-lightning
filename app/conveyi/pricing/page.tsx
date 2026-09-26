import type { Metadata } from 'next';
import { config } from '@/lib/server/config';
import { ctaHref, ROUTES, Cta, NavHeader, SiteFooter } from '../../_components/shared';

export const metadata: Metadata = {
  title: 'Pricing — CONVEYi',
  description:
    'One price: £100 per case. No seats, no tiers, no monthly fee. Pay only for the cases CONVEYi works on. 30-day money-back guarantee. Earn up to £50/month recurring for every firm you refer.',
};

const PAGE_SOURCE = 'pricing';

const included = [
  'CONVEYi add-in inside Outlook',
  'Thread summaries & case-aware draft replies',
  'Auto-triage incoming mail, matched to the right case',
  'Auto-rules: file, tag & draft on routine updates',
  'AI document packs & document review',
  'Per-case OneDrive knowledge base & live case board',
  'Unlimited email volume & onboarding lookback',
  'Unlimited seats — the whole firm, no per-user fee',
  'Case board, workload dashboard & assignment',
  'Team roles & admin oversight',
];

const whatCounts = [
  ['Charged once per case', 'The first time CONVEYi drafts a reply, reviews or generates a document, or reconciles a case, that case is opened and £100 goes on the month’s invoice. Never again for that case.'],
  ['Free: everything before that', 'Triage, matching, summaries and the knowledge base run on every email at no charge. A case you never draft on costs nothing.'],
  ['Free: your trial', 'Cases you open during the free trial are never charged — not then, and not when you subscribe.'],
];

export default function PricingPage() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      <section className="px-6 pt-16 pb-8 md:pt-24">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">Pricing</p>
          <h1 className="mt-4 font-serif text-5xl font-semibold leading-tight tracking-tight md:text-6xl">
            £100 per case. That’s the pricing.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink-soft">
            Start with {config.trialDays} days free — no card, no sales call. Then pay only for the
            cases CONVEYi actually works on: no seats, no tiers, no monthly fee. Everyone in the firm
            gets the whole product. No setup fees and no lock-in, and if it doesn’t save you time in
            the first 30 days, get your money back.
          </p>
        </div>
      </section>

      <section className="px-6 py-12 md:py-16">
        <div className="mx-auto grid max-w-6xl gap-6 md:grid-cols-5">
          <div className="relative rounded-3xl border-2 border-violet bg-paper-soft p-8 shadow-violet md:col-span-3 md:p-9">
            <span className="absolute -top-3 left-8 rounded-full bg-violet px-3 py-1 text-xs font-bold uppercase tracking-wider text-white">
              One plan
            </span>
            <h2 className="text-lg font-bold uppercase tracking-widest text-ink-soft">Per case</h2>
            <div className="mt-3 flex items-end gap-2">
              <span className="font-serif text-6xl font-semibold">£100</span>
              <span className="mb-2 text-ink-soft">/case</span>
            </div>
            <p className="mt-2 text-sm font-semibold text-violet">Unlimited seats · invoiced monthly</p>
            <p className="mt-3 text-ink-soft">The whole product for the whole firm. You pay for the cases you use it on.</p>
            <ul className="mt-7 grid gap-3 sm:grid-cols-2">
              {included.map((f) => (
                <li key={f} className="flex gap-3 text-ink">
                  <span className="mt-1 shrink-0 font-bold text-violet">✓</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <Cta
                label="Get started"
                href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'pricing_case')}
                dataCta="pricing_case"
                variant="primary"
                size="lg"
                className="w-full"
              />
            </div>
          </div>
          <div className="rounded-3xl border border-line bg-paper-soft p-8 md:col-span-2 md:p-9">
            <h2 className="text-lg font-bold uppercase tracking-widest text-ink-soft">What counts as a case</h2>
            <dl className="mt-6 space-y-6">
              {whatCounts.map(([k, v]) => (
                <div key={k}>
                  <dt className="font-semibold text-ink">{k}</dt>
                  <dd className="mt-1 text-ink-soft">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <div className="mx-auto mt-10 max-w-6xl rounded-2xl border border-violet/20 bg-violet-soft p-6 text-center md:p-8">
          <p className="font-serif text-2xl font-semibold tracking-tight">
            Earn it back: <span className="text-violet">up to £50/month recurring</span> for every firm you refer.
          </p>
          <p className="mt-2 text-ink-soft">A quarter of what each firm you refer pays, up to £50 a month — as account credit, for as long as they stay a customer. A few referrals and your own cases pay for themselves.</p>
        </div>

        <p className="mx-auto mt-8 max-w-6xl text-center text-sm text-ink-soft">
          30-day money-back guarantee. ·{' '}
          <a href={ctaHref(ROUTES.faq, PAGE_SOURCE, 'pricing_faq')} className="text-violet underline underline-offset-4">Read the FAQ</a>
        </p>
      </section>

      <section className="bg-ink px-6 py-20 text-paper md:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-serif text-4xl font-semibold tracking-tight md:text-5xl">One case at a time.</h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-paper/70">Try it on a live case for free. Add the whole team when you’re ready — it costs nothing until they open a case.</p>
          <div className="mt-8 flex justify-center">
            <Cta label="Get started" href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'cta_signup')} dataCta="cta_signup" size="lg" />
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
