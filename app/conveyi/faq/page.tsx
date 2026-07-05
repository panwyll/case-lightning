import type { Metadata } from 'next';
import { ctaHref, ROUTES, Cta, NavHeader, SiteFooter } from '../../_components/shared';

export const metadata: Metadata = {
  title: 'FAQ — CONVEYi',
  description:
    'Common questions about CONVEYi: GDPR, where your data lives, onboarding, the referral scheme, the 30-day money-back guarantee, and the Solo, Pro and Firm plans.',
};

const PAGE_SOURCE = 'faq';

const faqs = [
  {
    q: 'Is our data safe? Is it GDPR-compliant?',
    a: 'Yes. CONVEYi is GDPR-compliant by design. Your emails and case files stay inside your own Microsoft 365 tenant — we don’t copy them to a separate portal or store your documents on our servers. Every action is logged so you have a full audit trail.',
  },
  {
    q: 'Do we have to move our files or learn a new system?',
    a: 'No. That’s the whole point. CONVEYi works inside Outlook, files into your existing OneDrive, and keeps a tracker in Excel. There’s no migration, no new login, and no “portal” to learn — if your team can use Outlook, they can use CONVEYi today.',
  },
  {
    q: 'How long does setup take?',
    a: 'Minutes. There’s effectively zero onboarding overhead — you add the CONVEYi add-in to Outlook and you’re working. No training day, no data import, no IT project.',
  },
  {
    q: 'Where do the case files actually live?',
    a: 'Each matter gets its own folder in your OneDrive, with a live Excel tracker for parties, key dates and outstanding tasks. You can open and edit them like any other file — CONVEYi just keeps them current for you.',
  },
  {
    q: 'Will it send emails to clients on its own?',
    a: 'Only if you explicitly switch that on. By default everything is draft-only — replies land in your Drafts for a human to check and send. Automatic sending is a Pro/Firm-plan option, opt-in per rule, limited to routine updates, and you can turn it off at any time.',
  },
  {
    q: 'How does the referral scheme work?',
    a: 'It’s the most generous in legal software: refer another firm and you earn £50 every month they remain a customer — recurring, not a one-off. It’s paid as account credit, so a handful of referrals can cover your own subscription entirely.',
  },
  {
    q: 'What’s the difference between the Solo, Pro and Firm plans?',
    a: 'Solo (£39/month) gives one conveyancer the Outlook add-in, case-aware drafting, the chase-up worklist, the OneDrive knowledge base and the Excel tracker. Pro (£99/month) adds the automation: incoming mail is auto-matched to the right case, tagged, filed, and — where you allow it — answered automatically, plus AI document packs. Firm (£199/month, three seats included then £59 a seat) opens the practice up to the whole team: a matter board, a workload dashboard and matter assignment, with admin oversight.',
  },
  {
    q: 'What if it doesn’t work for us?',
    a: 'You’re covered by a 30-day money-back guarantee. If it doesn’t save your team time, ask for a refund — no awkward conversations, no lock-in.',
  },
  {
    q: 'Does it work with Gmail?',
    a: 'Not yet — CONVEYi is built for Outlook and Microsoft 365, which is where most UK conveyancing firms already work. Other platforms are on the roadmap.',
  },
];

export default function FaqPage() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      <section className="px-6 pt-16 pb-8 md:pt-24">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">FAQ</p>
          <h1 className="mt-4 font-serif text-5xl font-semibold leading-tight tracking-tight md:text-6xl">
            The questions firms actually ask.
          </h1>
        </div>
      </section>

      <section className="px-6 py-10 md:py-14">
        <div className="mx-auto max-w-3xl divide-y divide-line border-y border-line">
          {faqs.map((item) => (
            <details key={item.q} className="group py-2">
              <summary className="flex cursor-pointer items-center justify-between gap-4 py-5">
                <span className="font-serif text-xl font-semibold tracking-tight">{item.q}</span>
                <span aria-hidden="true" className="shrink-0 text-2xl font-light text-violet transition-transform duration-200 group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="pb-6 pr-8 text-lg leading-relaxed text-ink-soft">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="bg-ink px-6 py-20 text-paper md:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-serif text-4xl font-semibold tracking-tight md:text-5xl">Still have questions?</h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-paper/70">Get started and we’ll be in touch — or take a look at the plans.</p>
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
