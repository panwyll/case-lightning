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
  title: 'How It Works — CaseLightning',
  description:
    'See how CaseLightning gives every fee earner instant case insight inside Outlook — clear summaries, fast next actions, and confident client replies.',
};

const PAGE_SOURCE = 'how_it_works';

const features = [
  {
    icon: '⚖️',
    title: 'Add a QC to your team',
    body: 'Trained on 8,192 legal documents, CaseLightning gives every fee earner instant access to expert-level case insight.',
  },
  {
    icon: '📧',
    title: 'Who runs the world? Email.',
    body: 'Manage your transactions from exactly where you and your clients already operate — no new tools, no workflow changes.',
  },
  {
    icon: '☁️',
    title: 'Automate case knowledge',
    body: 'Keep your case files updated in OneDrive. Automatically. Your knowledge base stays current without anyone lifting a finger.',
  },
];

const steps = [
  {
    number: '01',
    title: 'Connect your Outlook',
    body: 'CaseLightning links to your existing Outlook account. No migration, no new inbox — your team keeps working exactly as before.',
  },
  {
    number: '02',
    title: 'Point it at a case',
    body: "Select a case thread and CaseLightning reads the emails, pulls out the key facts, and presents a clear summary in seconds.",
  },
  {
    number: '03',
    title: 'Get your next action',
    body: 'Receive a suggested next step based on the case status — draft a client update, chase a document, or flag a deadline.',
  },
  {
    number: '04',
    title: 'Reply with confidence',
    body: 'Use the suggested reply or edit it to your taste. Send it from Outlook as normal. No copy-pasting, no tab-switching.',
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────
export default function HowItWorksPage() {
  return (
    <main className="bg-slate-950 text-white antialiased">

      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      {/* ── HERO ── */}
      <section className="relative overflow-hidden bg-slate-950 px-6 pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="pointer-events-none absolute inset-0 flex items-start justify-center">
          <div
            aria-hidden="true"
            className="h-[500px] w-[700px] -translate-y-1/3 rounded-full bg-brand-500 opacity-[0.06] blur-3xl"
          />
        </div>
        <div className="relative mx-auto max-w-3xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-slate-400">How It Works</p>
          <h1 className="mt-3 text-4xl font-extrabold leading-tight tracking-tight md:text-5xl">
            Case intelligence,
            <br className="hidden sm:block" />
            <span className="text-brand-500"> right inside Outlook</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-400">
            No new tools. No workflow changes. CaseLightning works where your team already lives.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta
              label="Sign Up"
              href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'hero_signup')}
              dataCta="hero_signup"
              size="lg"
            />
            <Cta
              label="See Pricing"
              href={ctaHref(ROUTES.pricing, PAGE_SOURCE, 'hero_pricing')}
              dataCta="hero_pricing"
              variant="secondary"
              size="lg"
            />
          </div>
        </div>
      </section>

      {/* ── STEP-BY-STEP ── */}
      <section className="relative overflow-hidden bg-slate-900 px-6 py-16 md:py-24">
        <SectionBackground />
        <div className="relative mx-auto max-w-5xl">
          <h2 className="text-3xl font-bold md:text-4xl">Four steps to faster cases</h2>
          <p className="mt-3 text-lg text-slate-400">
            From setup to your first time-saving reply in minutes.
          </p>
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            {steps.map((step) => (
              <article
                key={step.number}
                className="rounded-2xl border border-slate-700 bg-slate-950 p-8 shadow-sm transition hover:border-brand-blue hover:shadow-glow-blue"
              >
                <span className="text-4xl font-extrabold text-brand-500 opacity-60">{step.number}</span>
                <h3 className="mt-3 text-xl font-bold text-white">{step.title}</h3>
                <p className="mt-2 text-slate-400">{step.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section className="relative overflow-hidden bg-slate-950 px-6 py-16 md:py-24">
        <SectionBackground />
        <div className="relative mx-auto max-w-6xl">
          <h2 className="text-3xl font-bold md:text-4xl">
            Everything your team needs to move faster
          </h2>
          <p className="mt-3 text-lg text-slate-400">
            Speed up every step. Keep clients happy. Grow without adding headcount.
          </p>
          <div className="mt-10 grid gap-6 sm:grid-cols-3">
            {features.map((f) => (
              <article
                key={f.title}
                className="rounded-2xl border border-slate-700 bg-slate-900 p-8 shadow-sm transition hover:border-brand-blue hover:shadow-glow-blue"
              >
                <span className="text-4xl">{f.icon}</span>
                <h3 className="mt-4 text-xl font-bold text-white">{f.title}</h3>
                <p className="mt-2 text-slate-400">{f.body}</p>
              </article>
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
          <h2 className="text-3xl font-extrabold md:text-5xl">
            Ready to move faster?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-slate-400">
            Join 50+ legal teams already saving hours every week.
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
          <p className="mt-6 text-sm text-slate-500">
            From £200/month &nbsp;·&nbsp; Money-back guarantee &nbsp;·&nbsp; No complicated setup
          </p>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
