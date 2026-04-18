// UTM / CTA helpers — edit here to update all links at once
const UTM = {
  source: 'landingpage',
  medium: 'cta',
  campaign: 'caselightning_launch',
} as const;

const ROUTES = {
  demo: '/book-demo',
  trial: '/start-trial',
  howItWorks: '#how-it-works',
} as const;

function ctaHref(path: string, content: string) {
  const p = new URLSearchParams({
    utm_source: UTM.source,
    utm_medium: UTM.medium,
    utm_campaign: UTM.campaign,
    utm_content: content,
  });
  return `${path}?${p.toString()}`;
}

// ── Reusable CTA button ───────────────────────────────────────────────────────
type CtaProps = {
  label: string;
  href: string;
  dataCta: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'md' | 'lg';
};

function Cta({ label, href, dataCta, variant = 'primary', size = 'md' }: CtaProps) {
  const base =
    'inline-flex items-center justify-center rounded-xl font-semibold transition-all duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500';

  const sizes = {
    md: 'px-6 py-3 text-base',
    lg: 'px-8 py-4 text-lg',
  };

  const variants = {
    primary: 'bg-brand-500 text-white hover:bg-brand-600 shadow-md hover:shadow-lg active:scale-95',
    secondary: 'border-2 border-slate-800 bg-white text-slate-900 hover:bg-slate-50',
    ghost: 'text-slate-700 hover:text-slate-900 underline underline-offset-4',
  };

  return (
    <a href={href} className={`${base} ${sizes[size]} ${variants[variant]}`} data-cta={dataCta}>
      {label}
    </a>
  );
}

// ── Page data ─────────────────────────────────────────────────────────────────
const benefits = [
  {
    icon: '⚡',
    title: 'Handle more cases without hiring',
    body: 'Move work forward faster. No extra headcount needed.',
  },
  {
    icon: '💬',
    title: 'Reply in minutes, not after digging through email',
    body: 'Get the full case picture instantly, then send a clear update.',
  },
  {
    icon: '📋',
    title: 'Turn long email chains into a clear crib sheet',
    body: 'Stop reading back through threads. See what matters, now.',
  },
  {
    icon: '😊',
    title: 'Give clients faster updates',
    body: 'Keep clients reassured and reduce chasing calls.',
  },
];

const steps = [
  {
    n: '1',
    title: 'Open a case in Outlook',
    body: 'CaseLightning works right where your team already is.',
  },
  {
    n: '2',
    title: 'See a clear case summary instantly',
    body: 'A simple crib sheet — no reading through long email chains.',
  },
  {
    n: '3',
    title: 'Take the next action fast',
    body: 'Reply, update the file, move on. Done in minutes.',
  },
];

const faqs = [
  {
    q: 'Is this only for big firms?',
    a: 'No. CaseLightning is built for small law firms, conveyancers, and other case-based teams that need speed.',
  },
  {
    q: 'Do we need to change how we work?',
    a: 'No. Your team works inside Outlook as normal. CaseLightning helps you move faster in the same flow.',
  },
  {
    q: 'How quickly will we see results?',
    a: 'Most teams notice the time savings within the first week because they stop digging through email threads.',
  },
  {
    q: "What if it doesn't save us time?",
    a: "If it doesn't save you time, don't keep it. You're covered by our money-back guarantee.",
  },
  {
    q: 'Does it work with our current setup?',
    a: 'Yes. If your team uses Outlook for case emails, CaseLightning works with no complicated setup.',
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Page() {
  return (
    <main className="bg-white text-slate-900 antialiased">
      {/* ── NAV ── */}
      <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="text-xl font-bold tracking-tight">
            Case<span className="text-brand-500">Lightning</span>
          </span>
          <div className="flex items-center gap-3">
            <Cta
              label="Book a Demo"
              href={ctaHref(ROUTES.demo, 'nav_book_demo')}
              dataCta="nav_book_demo"
              variant="secondary"
            />
            <Cta
              label="Start Free Trial"
              href={ctaHref(ROUTES.trial, 'nav_start_trial')}
              dataCta="nav_start_trial"
            />
          </div>
        </div>
      </header>

      {/* ── HERO ── */}
      <section className="bg-white px-6 pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="mx-auto max-w-4xl text-center">
          <div className="mb-5 inline-block rounded-full bg-brand-50 px-4 py-1.5 text-sm font-semibold text-brand-700">
            Built for small law firms &amp; conveyancers
          </div>
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight md:text-6xl">
            Handle more cases.<br className="hidden sm:block" />
            <span className="text-brand-500"> Reply faster.</span>
            <br className="hidden sm:block" />
            Make more money.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-600 md:text-xl">
            CaseLightning turns messy case email threads into a clear summary and fast next actions
            — right inside Outlook. Your team moves faster without hiring more staff.
          </p>
          <p className="mt-4 text-base font-semibold text-slate-800">
            £200/month &nbsp;·&nbsp; Money-back guarantee &nbsp;·&nbsp; No complicated setup
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta
              label="Book a Demo"
              href={ctaHref(ROUTES.demo, 'hero_book_demo')}
              dataCta="hero_book_demo"
              size="lg"
            />
            <Cta
              label="Start Free Trial"
              href={ctaHref(ROUTES.trial, 'hero_start_trial')}
              dataCta="hero_start_trial"
              size="lg"
              variant="secondary"
            />
            <Cta
              label="See How It Works ↓"
              href={ctaHref(ROUTES.howItWorks, 'hero_see_how_it_works')}
              dataCta="hero_see_how_it_works"
              variant="ghost"
            />
          </div>
        </div>
      </section>

      {/* ── PROBLEM ── */}
      <section className="bg-slate-50 px-6 py-16 md:py-24">
        <div className="mx-auto grid max-w-6xl gap-10 md:grid-cols-2 md:gap-16">
          <div>
            <h2 className="text-3xl font-bold leading-snug md:text-4xl">
              Your inbox is slowing your practice down
            </h2>
            <p className="mt-4 text-lg text-slate-600">
              Every minute your team spends digging through email chains is a minute they are not
              earning fees. Slow replies frustrate clients. Missed follow-ups lose instructions.
              And the only way to take on more cases seems to be hiring more people.
            </p>
            <p className="mt-4 text-lg font-semibold text-slate-900">There is a faster way.</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Sound familiar?
            </p>
            <ul className="space-y-3">
              {[
                'Reading back through email chains just to reply to a client',
                'Client updates going out late because the team is swamped',
                'Admin eating into fee-earning time every day',
                "Capacity stuck — you can't take on more without hiring",
              ].map((item) => (
                <li key={item} className="flex gap-3 text-slate-800">
                  <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-red-100 text-center text-xs font-bold leading-5 text-red-600">
                    ✕
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── BENEFITS ── */}
      <section className="px-6 py-16 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-3xl font-bold md:text-4xl">What CaseLightning does for you</h2>
          <p className="mt-3 text-lg text-slate-600">
            Speed up every step. Keep clients happy. Grow without adding headcount.
          </p>
          <div className="mt-10 grid gap-5 sm:grid-cols-2">
            {benefits.map((b) => (
              <article
                key={b.title}
                className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:shadow-md"
              >
                <span className="text-3xl">{b.icon}</span>
                <h3 className="mt-3 text-xl font-semibold">{b.title}</h3>
                <p className="mt-2 text-slate-600">{b.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section id="how-it-works" className="bg-slate-900 px-6 py-16 text-white md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-3xl font-bold md:text-4xl">How it works</h2>
          <p className="mt-3 max-w-2xl text-slate-300">
            No complex setup. Works inside Outlook. Your team gets up and running fast.
          </p>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {steps.map((s) => (
              <article key={s.n} className="rounded-2xl bg-slate-800 p-6">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500 text-sm font-bold text-white">
                  {s.n}
                </span>
                <h3 className="mt-4 text-xl font-semibold">{s.title}</h3>
                <p className="mt-2 text-slate-300">{s.body}</p>
              </article>
            ))}
          </div>
          <div className="mt-10">
            <Cta
              label="Start Free Trial"
              href={ctaHref(ROUTES.trial, 'midpage_start_trial')}
              dataCta="midpage_start_trial"
            />
          </div>
        </div>
      </section>

      {/* ── ROI ── */}
      <section className="bg-brand-50 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-3xl font-bold md:text-4xl">£200/month is tiny next to the upside</h2>
          <p className="mt-4 max-w-2xl text-lg text-slate-700">
            If CaseLightning helps you handle even one extra case, it pays for itself many times
            over. Most teams see that in the first week.
          </p>
          <div className="mt-8 grid gap-5 sm:grid-cols-3">
            {[
              {
                stat: 'More cases',
                body: 'Your current team handles more matters without hitting a workload ceiling.',
              },
              {
                stat: 'Less admin',
                body: 'Stop losing fee-earning time to inbox digging and repetitive updates.',
              },
              {
                stat: 'More revenue',
                body: 'More capacity + faster throughput = more fees billed without more staff.',
              },
            ].map((card) => (
              <div key={card.stat} className="rounded-2xl border border-brand-100 bg-white p-6 shadow-sm">
                <p className="text-2xl font-extrabold text-brand-600">{card.stat}</p>
                <p className="mt-2 text-slate-700">{card.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING ── */}
      <section className="px-6 py-16 md:py-24">
        <div className="mx-auto max-w-xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-slate-500">
            Simple, transparent pricing
          </p>
          <div className="mt-4 rounded-3xl border-2 border-brand-500 p-8 shadow-xl">
            <p className="text-5xl font-extrabold text-brand-500">£200</p>
            <p className="mt-1 text-lg font-semibold text-slate-700">per month</p>
            <ul className="mt-6 space-y-2 text-left">
              {[
                'Unlimited cases',
                'Works inside Outlook',
                'Clear case summaries on demand',
                'Fast next-action suggestions',
                'Money-back guarantee',
              ].map((f) => (
                <li key={f} className="flex items-center gap-2 text-slate-800">
                  <span className="text-emerald-500 font-bold">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm font-semibold text-slate-700">
              If it doesn't save you time, don't keep it.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
              <Cta
                label="Start Free Trial"
                href={ctaHref(ROUTES.trial, 'pricing_start_trial')}
                dataCta="pricing_start_trial"
                size="lg"
              />
              <Cta
                label="Book a Demo"
                href={ctaHref(ROUTES.demo, 'pricing_book_demo')}
                dataCta="pricing_book_demo"
                variant="secondary"
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── GUARANTEE ── */}
      <section className="px-6 pb-16 md:pb-24">
        <div className="mx-auto max-w-3xl rounded-2xl border border-emerald-300 bg-emerald-50 px-8 py-8 text-center">
          <p className="text-4xl">🛡️</p>
          <h2 className="mt-3 text-2xl font-bold">Money-back guarantee</h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-700">
            Try CaseLightning with your real caseload. If it does not help your team save time and
            move faster, cancel and get your money back. No awkward conversations.
          </p>
          <p className="mt-4 font-semibold text-slate-900">
            "If it doesn't save you time, don't keep it."
          </p>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="bg-slate-50 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold md:text-4xl">Questions &amp; answers</h2>
          <div className="mt-8 space-y-4">
            {faqs.map((item) => (
              <article key={item.q} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h3 className="text-lg font-semibold">{item.q}</h3>
                <p className="mt-2 text-slate-600">{item.a}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="bg-slate-900 px-6 py-16 text-white md:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-extrabold md:text-5xl">Start handling more cases this month</h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-slate-300">
            Reply faster, cut admin, keep clients happier — without adding headcount.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta
              label="Book a Demo"
              href={ctaHref(ROUTES.demo, 'footer_book_demo')}
              dataCta="footer_book_demo"
              size="lg"
            />
            <Cta
              label="Start Free Trial"
              href={ctaHref(ROUTES.trial, 'footer_start_trial')}
              dataCta="footer_start_trial"
              size="lg"
              variant="secondary"
            />
          </div>
          <p className="mt-6 text-sm text-slate-400">
            £200/month &nbsp;·&nbsp; Money-back guarantee &nbsp;·&nbsp; No complicated setup
          </p>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="border-t border-slate-200 px-6 py-8 text-center text-sm text-slate-500">
        © {new Date().getFullYear()} CaseLightning. All rights reserved.
      </footer>
    </main>
  );
}
