// UTM / CTA helpers — edit here to update all links at once
const UTM = {
  source: 'landingpage',
  medium: 'cta',
  campaign: 'caselightning_launch',
} as const;

const ROUTES = {
  signup: '/waitlist',
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

// ── Subtle SVG background iconography ────────────────────────────────────────
function ScaleIcon() {
  return (
    <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="50" y1="12" x2="50" y2="82" />
      <line x1="18" y1="18" x2="82" y2="18" />
      <path d="M18,18 L8,44 L28,44 Z" />
      <path d="M82,18 L72,44 L92,44 Z" />
      <line x1="36" y1="82" x2="64" y2="82" />
    </svg>
  );
}

function LightningIcon() {
  return (
    <svg viewBox="0 0 100 100" fill="currentColor">
      <path d="M58,5 L20,55 L43,55 L40,95 L80,45 L57,45 Z" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22,5 H60 L78,24 V95 H22 Z" />
      <path d="M60,5 V24 H78" />
      <line x1="33" y1="42" x2="67" y2="42" />
      <line x1="33" y1="57" x2="67" y2="57" />
      <line x1="33" y1="72" x2="54" y2="72" />
    </svg>
  );
}

function GavelIcon() {
  return (
    <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="30" y1="70" x2="14" y2="86" strokeWidth="5" />
      <line x1="36" y1="64" x2="68" y2="32" />
      <rect x="52" y="8" width="38" height="22" rx="5" transform="rotate(45 71 19)" />
    </svg>
  );
}

type BgPos = [number, number, number, number, number]; // x%, y%, size(px), rot(deg), iconIdx

const ICON_COMPONENTS = [ScaleIcon, LightningIcon, DocIcon, GavelIcon];

const HERO_BG: BgPos[] = [
  [4, 8, 56, -12, 0], [16, 74, 44, 15, 1], [28, 4, 50, -5, 2],
  [72, 7, 48, 20, 3], [86, 14, 54, -18, 0], [93, 66, 42, 10, 1],
  [8, 46, 38, -8, 2], [50, 84, 46, 12, 3], [38, 18, 40, 8, 1],
  [62, 70, 50, -10, 0],
];

const SECTION_BG: BgPos[] = [
  [2, 7, 50, -12, 0], [20, 2, 40, 15, 1], [36, 84, 46, -5, 2],
  [54, 4, 44, 20, 3], [70, 80, 52, -18, 0], [88, 10, 42, 10, 1],
  [95, 54, 44, -8, 2], [12, 60, 38, 12, 3], [46, 44, 36, 8, 1],
  [78, 38, 48, -10, 0],
];

function SectionBackground({ positions = SECTION_BG }: { positions?: BgPos[] }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden select-none">
      {positions.map(([x, y, size, rot, iconIdx], i) => {
        const Icon = ICON_COMPONENTS[iconIdx];
        return (
          <div
            key={i}
            className="absolute text-white opacity-[0.04]"
            style={{ left: `${x}%`, top: `${y}%`, width: size, height: size, transform: `rotate(${rot}deg)` }}
          >
            <Icon />
          </div>
        );
      })}
    </div>
  );
}

// ── Reusable CTA button ───────────────────────────────────────────────────────
type CtaProps = {
  label: string;
  href: string;
  dataCta: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'md' | 'lg';
  className?: string;
};

function Cta({ label, href, dataCta, variant = 'primary', size = 'md', className = '' }: CtaProps) {
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
    <a href={href} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} data-cta={dataCta}>
      {label}
    </a>
  );
}

// ── Page data ─────────────────────────────────────────────────────────────────
const features = [
  {
    icon: '⚖️',
    title: 'Add a QC to your team',
    body: 'Trained on 8,192 legal documents, CaseLightning gives every fee earner instant access to expert-level case insight.',
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
      "We were sceptical, but the no-fuss setup and the money-back guarantee made us try it. Now I can't imagine going back.",
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
];

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Page() {
  return (
    <main className="bg-slate-950 text-white antialiased">

      {/* ── NAV ── */}
      <header className="sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/95 backdrop-blur shadow-[0_1px_20px_rgba(0,0,0,0.5)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <span className="text-xl font-bold tracking-tight">
            Case<span className="text-brand-500">Lightning</span>
          </span>
          <nav className="hidden items-center gap-8 text-sm font-medium text-slate-400 md:flex">
            <a href="#features" className="transition-colors hover:text-white">Features</a>
            <a href="#pricing" className="transition-colors hover:text-white">Pricing</a>
            <a href="#faq" className="transition-colors hover:text-white">FAQ</a>
          </nav>
          <div className="flex items-center gap-3">
            <Cta
              label="Sign Up"
              href={ctaHref(ROUTES.signup, 'nav_signup')}
              dataCta="nav_signup"
            />
          </div>
        </div>
      </header>

      {/* ── HERO ── */}
      <section className="relative overflow-hidden bg-slate-950 px-6 pb-24 pt-20 md:pb-32 md:pt-28">
        <div className="pointer-events-none absolute inset-0 flex items-start justify-center">
          <div
            aria-hidden="true"
            className="h-[600px] w-[800px] -translate-y-1/3 rounded-full bg-brand-500 opacity-[0.06] blur-3xl"
          />
        </div>
        <SectionBackground positions={HERO_BG} />

        <div className="relative mx-auto max-w-4xl text-center">
          {/* 5-star rating badge */}
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-slate-700/80 bg-slate-900/80 px-4 py-1.5 text-sm text-slate-300 shadow-[0_2px_12px_rgba(0,0,0,0.4)]">
            <span className="flex gap-0.5 text-yellow-400 text-base leading-none">★★★★★</span>
            <span>Rated 5/5 by 50+ legal teams</span>
          </div>

          <h1 className="text-4xl font-extrabold leading-tight tracking-tight md:text-6xl">
            10X More Cases.
            <br className="hidden sm:block" />
            <span className="text-brand-500"> Without Leaving Outlook.</span>
            <br className="hidden sm:block" />
            Or your money back.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400">
            CaseLightning gives every fee earner instant case insight — clear summaries, fast next actions, and confident client replies — all from inside Outlook.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta
              label="Sign Up"
              href={ctaHref(ROUTES.signup, 'hero_signup')}
              dataCta="hero_signup"
              size="lg"
            />
          </div>

        </div>
      </section>

      {/* ── FEATURES ── */}
      <section id="features" className="relative overflow-hidden bg-slate-900 px-6 py-16 md:py-24">
        <SectionBackground />
        <div className="relative mx-auto max-w-6xl">
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
                className="rounded-2xl border border-slate-700/60 bg-slate-950/80 p-6 shadow-[0_4px_24px_rgba(0,0,0,0.45)] transition duration-200 hover:border-brand-blue hover:shadow-[0_6px_32px_rgba(0,212,255,0.15)]"
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
      <section id="pricing" className="relative overflow-hidden bg-slate-950 px-6 py-16 md:py-24">
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div aria-hidden="true" className="h-[400px] w-[900px] rounded-full bg-brand-500 opacity-[0.04] blur-3xl" />
        </div>
        <SectionBackground />
        <div className="relative mx-auto max-w-5xl">
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-widest text-slate-400">
              Simple, transparent pricing
            </p>
            <h2 className="mt-2 text-3xl font-bold md:text-4xl">Choose your plan</h2>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-2">
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
                <h3 className="text-xl font-bold text-white">{tier.name}</h3>
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
                  If it doesn't save you time, don't keep it.
                </p>
                <div className="mt-6">
                  <Cta
                    label="Sign Up"
                    href={ctaHref(ROUTES.signup, tier.ctaContent)}
                    dataCta={tier.ctaContent}
                    variant={tier.highlight ? 'primary' : 'secondary'}
                    size="lg"
                    className="w-full justify-center"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── TESTIMONIALS ── */}
      <section className="relative overflow-hidden bg-slate-900 px-6 py-16 md:py-24">
        <SectionBackground />
        <div className="relative mx-auto max-w-6xl">
          <h2 className="text-3xl font-bold md:text-4xl">What firms are saying</h2>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {testimonials.map((t) => (
              <article
                key={t.author}
                className="rounded-2xl border border-slate-700/60 bg-slate-950/80 p-6 shadow-[0_4px_24px_rgba(0,0,0,0.45)]"
              >
                <div className="mb-3 flex gap-0.5 text-sm text-yellow-400">★★★★★</div>
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
      <section id="faq" className="relative overflow-hidden bg-slate-950 px-6 py-16 md:py-24">
        <SectionBackground />
        <div className="relative mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold md:text-4xl">Questions &amp; answers</h2>
          <div className="mt-8 space-y-3">
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

      {/* ── FINAL CTA ── */}
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
            Start handling more cases this month
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-slate-400">
            Reply faster, cut admin, keep clients happier — without adding headcount.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta
              label="Sign Up"
              href={ctaHref(ROUTES.signup, 'footer_signup')}
              dataCta="footer_signup"
              size="lg"
            />
          </div>
          <p className="mt-6 text-sm text-slate-500">
            From £200/month &nbsp;·&nbsp; Money-back guarantee &nbsp;·&nbsp; No complicated setup
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
