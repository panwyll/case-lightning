import type { Metadata } from 'next';
import { ctaHref, ROUTES, Cta, NavHeader, SiteFooter } from '../../_components/shared';

export const metadata: Metadata = {
  title: 'How it works — CONVEYi',
  description:
    'CONVEYi works inside Outlook. Point it at a case thread and it summarises, drafts the reply, files to OneDrive and updates your Excel tracker — no new portal, no onboarding.',
};

const PAGE_SOURCE = 'how_it_works';

const steps = [
  {
    n: '01',
    title: 'Open the email you’re already in',
    body: 'The CONVEYi sidebar opens beside any message in Outlook. No new tab, no separate login — it’s right there in the inbox your team lives in.',
  },
  {
    n: '02',
    title: 'It finds the matter',
    body: 'CONVEYi matches the email to the right case using the thread, the people on it and the property — robustly, so a counterparty firm or repeat investor is never confused for the wrong file.',
  },
  {
    n: '03',
    title: 'Summary, next action, draft reply',
    body: 'In seconds you get what happened, what’s outstanding, and a case-aware draft reply written in your firm’s style — ready in your Drafts to check and send.',
  },
  {
    n: '04',
    title: 'Everything filed, automatically',
    body: 'The email and its attachments are saved to the case’s OneDrive folder, and the live Excel tracker is updated — so nothing gets lost and nobody re-keys anything.',
  },
];

export default function HowItWorksPage() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      <section className="px-6 pt-16 pb-12 md:pt-24">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">How it works</p>
          <h1 className="mt-4 font-serif text-5xl font-semibold leading-tight tracking-tight md:text-6xl">
            It works where your team already works.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink-soft">
            No migration. No new system to learn. CONVEYi sits inside Outlook and quietly does the
            admin around every case.
          </p>
        </div>
      </section>

      <section className="px-6 py-12 md:py-16">
        <div className="mx-auto max-w-5xl divide-y divide-line border-y border-line">
          {steps.map((s) => (
            <div key={s.n} className="grid gap-4 py-10 md:grid-cols-[auto_1fr] md:gap-12">
              <div className="font-serif text-5xl font-semibold text-violet md:text-6xl">{s.n}</div>
              <div>
                <h2 className="font-serif text-2xl font-semibold tracking-tight md:text-3xl">{s.title}</h2>
                <p className="mt-3 max-w-2xl text-lg text-ink-soft">{s.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="px-6 pb-8">
        <div className="mx-auto max-w-5xl rounded-3xl border border-violet/20 bg-violet-soft p-10 md:p-12">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">On the Team plan</p>
          <h2 className="mt-3 font-serif text-3xl font-semibold tracking-tight md:text-4xl">
            The routine handles itself.
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-ink-soft">
            New mail is matched to its case the moment it arrives, tagged in Outlook, filed, and — for
            the status updates that don’t need you — answered automatically by rules you control. You
            stay in charge: auto-send is opt-in per rule, and you can turn it off any time.
          </p>
        </div>
      </section>

      <section className="bg-ink px-6 py-20 text-paper md:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-serif text-4xl font-semibold tracking-tight md:text-5xl">See it on your own inbox.</h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-paper/70">Set up takes minutes — because there’s nothing to set up.</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta label="Get started" href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'cta_signup')} dataCta="cta_signup" size="lg" />
            <Cta label="See pricing" href={ctaHref(ROUTES.pricing, PAGE_SOURCE, 'cta_pricing')} dataCta="cta_pricing" variant="secondary" size="lg" className="border-paper/30 text-paper hover:bg-paper hover:text-ink" />
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
