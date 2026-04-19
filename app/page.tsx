// UTM / CTA helpers — edit here to update all links at once
const UTM = {
  source: 'landingpage',
  medium: 'cta',
  campaign: 'caselightning_launch',
} as const;

const ROUTES = {
  demo: '/book-demo',
  trial: '/start-trial',
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
    'inline-flex items-center justify-center rounded-xl font-semibold transition-all duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-pink';

  const sizes = {
    md: 'px-6 py-3 text-base',
    lg: 'px-8 py-4 text-lg',
  };

  const variants = {
    primary:
      'bg-brand-pink text-white hover:bg-brand-pink-dim shadow-glow-pink hover:shadow-[0_0_35px_rgba(255,45,120,0.65)] active:scale-95',
    secondary:
      'border-2 border-slate-600 bg-transparent text-white hover:border-brand-blue hover:text-brand-blue active:scale-95',
    ghost: 'text-slate-400 hover:text-brand-blue underline underline-offset-4',
  };

  return (
    <a href={href} className={`${base} ${sizes[size]} ${variants[variant]}`} data-cta={dataCta}>
      {label}
    </a>
  );
}

// ── Page data ─────────────────────────────────────────────────────────────────
const features = [
  {
    icon: '⚡',
    title: 'Handle more cases without hiring',
    body: 'Move work forward faster with your current team. No extra headcount needed.',
  },
  {
    icon: '💬',
    title: 'Reply in minutes, not after digging through email',
    body: 'Get the full case picture instantly, then send a clear, confident update.',
  },
  {
    icon: '📋',
    title: 'Turn long email chains into a clear crib sheet',
    body: 'Stop reading back through threads. See what matters — now.',
  },
  {
    icon: '😊',
    title: 'Give clients faster, better updates',
    body: 'Keep clients reassured and reduce time-wasting chasing calls.',
  },
];

const testimonials = [
  {
    quote:
      'We cut the time spent reading back through emails by more than half. The team handles more cases without anyone working late.',
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
      'We were sceptical, but the no-fuss setup and the money-back guarantee made us try it. Now I can\'t imagine going back.',
    author: 'Rachel P.',
    role: 'Director, family law firm',
  },
];

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
];

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Page() {
  return (
    <main className="bg-slate-950 text-white antialiased">

      {/* ── NAV ── */}
      <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
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
      <section className="relative overflow-hidden bg-slate-950 px-6 pb-24 pt-20 md:pb-32 md:pt-28">
        {/* Subtle radial glow behind headline */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-start justify-center"
        >
          <div className="h-[500px] w-[700px] -translate-y-1/3 rounded-full bg-brand-500 opacity-[0.07] blur-3xl" />
        </div>

        <div className="relative mx-auto max-w-4xl text-center">
          <div className="mb-5 inline-block rounded-full border border-brand-500/40 bg-brand-500/10 px-4 py-1.5 text-sm font-semibold text-brand-500">
            Built for small law firms &amp; conveyancers
          </div>
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight md:text-6xl">
            Handle more cases.
            <br className="hidden sm:block" />
            <span className="text-brand-500"> Reply faster.</span>
            <br className="hidden sm:block" />
            Make more money.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400 md:text-xl">
            CaseLightning turns messy case email threads into a clear summary and fast next actions
            — right inside Outlook. Your team moves faster without hiring more staff.
          </p>
          <p className="mt-4 text-base font-semibold text-slate-300">
            £200/month &nbsp;·&nbsp; Money-back guarantee &nbsp;·&nbsp; No complicated setup
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta
              label="Start Free Trial"
              href={ctaHref(ROUTES.trial, 'hero_start_trial')}
              dataCta="hero_start_trial"
              size="lg"
            />
            <Cta
              label="Book a Demo"
              href={ctaHref(ROUTES.demo, 'hero_book_demo')}
              dataCta="hero_book_demo"
              size="lg"
              variant="secondary"
            />
          </div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section id="features" className="bg-slate-900 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-3xl font-bold md:text-4xl">
            Everything your team needs to move faster
          </h2>
          <p className="mt-3 text-lg text-slate-400">
            Speed up every step. Keep clients happy. Grow without adding headcount.
          </p>
          <div className="mt-10 grid gap-5 sm:grid-cols-2">
            {features.map((f) => (
              <article
                key={f.title}
                className="rounded-2xl border border-slate-700 bg-slate-950 p-6 shadow-sm transition hover:border-brand-blue hover:shadow-glow-blue"
              >
                <span className="text-3xl">{f.icon}</span>
                <h3 className="mt-3 text-xl font-semibold text-white">{f.title}</h3>
                <p className="mt-2 text-slate-400">{f.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING ── */}
      <section id="pricing" className="bg-slate-950 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-slate-400">
            Simple, transparent pricing
          </p>
          <div className="mt-4 rounded-3xl border-2 border-brand-500 bg-slate-900 p-8 shadow-glow-yellow">
            <p className="text-5xl font-extrabold text-brand-500">£200</p>
            <p className="mt-1 text-lg font-semibold text-slate-300">per month</p>
            <ul className="mt-6 space-y-2 text-left">
              {[
                'Unlimited cases',
                'Works inside Outlook',
                'Clear case summaries on demand',
                'Fast next-action suggestions',
                'Money-back guarantee',
              ].map((item) => (
                <li key={item} className="flex items-center gap-2 text-slate-200">
                  <span className="font-bold text-brand-500">✓</span>
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm font-semibold text-slate-400">
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

      {/* ── TESTIMONIALS ── */}
      <section className="bg-slate-900 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-3xl font-bold md:text-4xl">What firms are saying</h2>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {testimonials.map((t) => (
              <article
                key={t.author}
                className="rounded-2xl border border-slate-700 bg-slate-950 p-6"
              >
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

      {/* ── FAQs ── */}
      <section id="faq" className="bg-slate-950 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold md:text-4xl">Questions &amp; answers</h2>
          <div className="mt-8 space-y-3">
            {faqs.map((item) => (
              <details
                key={item.q}
                className="group rounded-2xl border border-slate-700 bg-slate-900 open:border-brand-blue open:shadow-glow-blue"
              >
                <summary className="flex items-center justify-between gap-4 px-6 py-5">
                  <span className="text-lg font-semibold text-white">{item.q}</span>
                  <span className="shrink-0 text-xl text-brand-blue transition group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="px-6 pb-5 text-slate-400">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="relative overflow-hidden bg-slate-900 px-6 py-16 md:py-24">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <div className="h-[400px] w-[600px] rounded-full bg-brand-pink opacity-[0.08] blur-3xl" />
        </div>
        <div className="relative mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-extrabold md:text-5xl">
            Start handling more cases this month
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-slate-400">
            Reply faster, cut admin, keep clients happier — without adding headcount.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta
              label="Start Free Trial"
              href={ctaHref(ROUTES.trial, 'footer_start_trial')}
              dataCta="footer_start_trial"
              size="lg"
            />
            <Cta
              label="Book a Demo"
              href={ctaHref(ROUTES.demo, 'footer_book_demo')}
              dataCta="footer_book_demo"
              size="lg"
              variant="secondary"
            />
          </div>
          <p className="mt-6 text-sm text-slate-500">
            £200/month &nbsp;·&nbsp; Money-back guarantee &nbsp;·&nbsp; No complicated setup
          </p>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="border-t border-slate-800 px-6 py-8 text-center text-sm text-slate-600">
        © {new Date().getFullYear()} CaseLightning. All rights reserved.
      </footer>
    </main>
  );
}
