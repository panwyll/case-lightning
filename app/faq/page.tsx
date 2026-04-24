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
  title: 'FAQ — CaseLightning',
  description:
    'Answers to common questions about CaseLightning — setup, compatibility, pricing, and our money-back guarantee.',
};

const PAGE_SOURCE = 'faq';

const faqs = [
  {
    q: 'Is this only for big firms?',
    a: 'No. CaseLightning is built for small law firms, conveyancers, and other case-based teams that need speed without the overhead.',
  },
  {
    q: 'Do we need to change how we work?',
    a: 'No. Your team works inside Outlook as normal. CaseLightning helps you move faster in the same flow.',
  },
  {
    q: 'Is it available on Gmail?',
    a: 'Not yet — CaseLightning currently works with Outlook. Gmail support is on our roadmap and coming soon.',
  },
  {
    q: 'How quickly will we see results?',
    a: 'Most teams notice the time savings within the first week because they stop digging through email threads.',
  },
  {
    q: "What if it doesn't save us time?",
    a: "If it doesn't save you time, don't keep it. You're covered by our money-back guarantee — no awkward conversations.",
  },
  {
    q: 'Does it work with our current setup?',
    a: 'Yes. If your team uses Outlook for case emails, CaseLightning works with no complicated setup required.',
  },
  {
    q: 'How much does it cost?',
    a: 'Plans start at £200/month for up to 5 users. See our pricing page for full details.',
  },
  {
    q: 'Can I upgrade or downgrade my plan?',
    a: 'Yes — you can change your plan at any time. There are no long-term contracts.',
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────
export default function FaqPage() {
  return (
    <main className="bg-slate-950 text-white antialiased">

      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      {/* ── HERO ── */}
      <section className="relative overflow-hidden bg-slate-950 px-6 pb-8 pt-16 md:pt-24">
        <div className="pointer-events-none absolute inset-0 flex items-start justify-center">
          <div
            aria-hidden="true"
            className="h-[400px] w-[700px] -translate-y-1/3 rounded-full bg-brand-blue opacity-[0.04] blur-3xl"
          />
        </div>
        <div className="relative mx-auto max-w-3xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-slate-400">FAQ</p>
          <h1 className="mt-3 text-4xl font-extrabold leading-tight tracking-tight md:text-5xl">
            Questions &amp; answers
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-slate-400">
            Everything you need to know before getting started.
          </p>
        </div>
      </section>

      {/* ── FAQ ACCORDION ── */}
      <section className="relative overflow-hidden bg-slate-950 px-6 py-12 md:py-20">
        <SectionBackground />
        <div className="relative mx-auto max-w-3xl">
          <div className="space-y-3">
            {faqs.map((item) => (
              <details
                key={item.q}
                className="group rounded-2xl border border-slate-700/60 bg-slate-900 shadow-[0_2px_16px_rgba(0,0,0,0.35)] open:border-brand-blue open:shadow-[0_4px_24px_rgba(0,212,255,0.12)]"
              >
                <summary className="flex cursor-pointer items-center justify-between gap-4 px-6 py-5">
                  <span className="text-lg font-semibold text-white">{item.q}</span>
                  <span aria-hidden="true" className="shrink-0 text-xl text-brand-blue transition-transform duration-200 group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="px-6 pb-5 text-slate-400">{item.a}</p>
              </details>
            ))}
          </div>
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
            Still have questions?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-slate-400">
            Sign up and we&apos;ll be in touch. Or explore our pricing to find the right plan for your firm.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta
              label="Sign Up"
              href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'cta_signup')}
              dataCta="cta_signup"
              size="lg"
            />
            <Cta
              label="See Pricing"
              href={ctaHref(ROUTES.pricing, PAGE_SOURCE, 'cta_pricing')}
              dataCta="cta_pricing"
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
