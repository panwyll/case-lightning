import {
  ctaHref,
  ROUTES,
  Cta,
  NavHeader,
  SiteFooter,
  NinetyNinePie,
} from './_components/shared';

const PAGE_SOURCE = 'landing';

const tools = [
  {
    name: 'Outlook',
    body: 'The add-in lives in your inbox. It reads the thread, drafts the reply, and files everything — you never leave the email you were already in.',
  },
  {
    name: 'OneDrive',
    body: 'Every matter gets its own folder in the OneDrive you already have. Contracts, searches, saved emails — one tidy place, automatically.',
  },
  {
    name: 'Excel',
    body: 'A live Excel tracker per case keeps parties, key dates and outstanding tasks in one sheet. It updates itself, so nothing slips through.',
  },
];

const proof = [
  ['GDPR-compliant by design', 'Your data never leaves your own Microsoft 365 tenant. We don’t copy your files to a third-party portal.'],
  ['Zero onboarding', 'No migration, no new logins, no training day. If your team can use Outlook, they can use this today.'],
  ['Draft-only, always', 'Nothing is sent without a human. Every reply lands in your Drafts for you to check and send.'],
];

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
            Triple your transaction output.
            <span className="block italic text-violet">Without hiring.</span>
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-relaxed text-ink-soft md:text-xl">
            Conveyancing is mostly email — chasing, updating, replying, filing. CONVEYi takes that
            off your fee earners’ plates, right inside Outlook, so the same team moves far more cases.
          </p>
          <div className="mt-9 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <Cta label="Get started" href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'hero_signup')} dataCta="hero_signup" size="lg" />
            <Cta label="See how it works" href={ctaHref(ROUTES.howItWorks, PAGE_SOURCE, 'hero_how')} dataCta="hero_how" variant="secondary" size="lg" />
          </div>
          <p className="mt-5 text-sm text-ink-soft">
            From £200/month · 30-day money-back guarantee · nothing to install
          </p>
        </div>
      </section>

      {/* ── 99% / 1% (ink section for contrast) ── */}
      <section className="bg-ink px-6 py-20 text-paper md:py-28">
        <div className="mx-auto grid max-w-6xl items-center gap-12 md:grid-cols-2">
          <div>
            <h2 className="font-sans text-5xl font-extrabold leading-none tracking-tight md:text-7xl">
              Leave the <span className="text-[#A78BFA]">99%</span> to us.
            </h2>
            <p className="mt-6 max-w-md text-lg text-paper/70">
              The work that eats the day isn’t the law — it’s the inbox. CONVEYi handles the 99% so
              your people spend their hours on the 1% that actually needs a conveyancer.
            </p>
          </div>
          <div className="flex flex-col items-center">
            <NinetyNinePie size={240} />
            <div className="mt-6 grid w-full max-w-xs grid-cols-2 gap-4 text-sm">
              <div className="rounded-xl bg-white/5 p-4">
                <div className="text-2xl font-extrabold text-[#A78BFA]">99%</div>
                <div className="mt-1 text-paper/70">Emails, updates, chasing, more emails</div>
              </div>
              <div className="rounded-xl bg-white/5 p-4">
                <div className="text-2xl font-extrabold">1%</div>
                <div className="mt-1 text-paper/70">Actual conveyancing</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── LIVES IN YOUR TOOLS ── */}
      <section className="px-6 py-20 md:py-28">
        <div className="mx-auto max-w-6xl">
          <h2 className="max-w-2xl font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            It lives in the tools you already pay for.
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-ink-soft">
            No new portal to log into. No “system” to learn. Your cases stay where they already are —
            in Microsoft 365.
          </p>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-3">
            {tools.map((t, i) => (
              <div key={t.name} className="bg-paper-soft p-8">
                <div className="flex items-baseline gap-3">
                  <span className="font-serif text-3xl font-semibold text-violet">{String(i + 1).padStart(2, '0')}</span>
                  <h3 className="text-xl font-bold">{t.name}</h3>
                </div>
                <p className="mt-3 text-ink-soft">{t.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PROOF / TRUST ── */}
      <section className="border-y border-line bg-paper-soft px-6 py-20 md:py-24">
        <div className="mx-auto grid max-w-6xl gap-10 md:grid-cols-3">
          {proof.map(([title, body]) => (
            <div key={title}>
              <h3 className="font-serif text-2xl font-semibold tracking-tight">{title}</h3>
              <p className="mt-3 text-ink-soft">{body}</p>
            </div>
          ))}
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
            <h2 className="font-serif text-4xl font-semibold tracking-tight md:text-5xl">Two plans. No lock-in.</h2>
            <Cta label="See full pricing" href={ctaHref(ROUTES.pricing, PAGE_SOURCE, 'pricing_teaser')} dataCta="pricing_teaser" variant="ghost" />
          </div>
          <div className="mt-10 grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-line bg-paper-soft p-8">
              <div className="text-sm font-semibold uppercase tracking-widest text-ink-soft">Standard</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£200<span className="text-lg font-sans font-normal text-ink-soft">/mo</span></div>
              <p className="mt-3 text-ink-soft">Everything a small firm needs to clear the inbox and move every case faster.</p>
            </div>
            <div className="rounded-2xl border-2 border-violet bg-paper-soft p-8 shadow-violet">
              <div className="text-sm font-semibold uppercase tracking-widest text-violet">Team</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£500<span className="text-lg font-sans font-normal text-ink-soft">/mo</span></div>
              <p className="mt-3 text-ink-soft">Adds auto-triage and auto-rules: routine emails get matched, filed and answered for you.</p>
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
