const UTM_DEFAULTS = {
  source: 'landingpage',
  medium: 'cta',
  campaign: 'caselightning_launch',
} as const;

const CTA_ROUTES = {
  demo: '/book-demo',
  trial: '/start-trial',
  howItWorks: '/how-it-works',
} as const;

const buildCtaHref = (path: string, content: string) => {
  const params = new URLSearchParams({
    utm_source: UTM_DEFAULTS.source,
    utm_medium: UTM_DEFAULTS.medium,
    utm_campaign: UTM_DEFAULTS.campaign,
    utm_content: content,
  });

  return `${path}?${params.toString()}`;
};

type CtaButtonProps = {
  label: string;
  href: string;
  dataCta: string;
  variant?: 'primary' | 'secondary' | 'text';
};

function CtaButton({ label, href, dataCta, variant = 'primary' }: CtaButtonProps) {
  const base =
    'inline-flex items-center justify-center rounded-lg px-6 py-3 text-base font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900';

  const styles = {
    primary: `${base} bg-slate-900 text-white hover:bg-slate-800`,
    secondary: `${base} border border-slate-300 bg-white text-slate-900 hover:bg-slate-50`,
    text: `${base} px-0 py-0 font-medium text-slate-700 hover:text-slate-900`,
  };

  return (
    <a href={href} className={styles[variant]} data-cta={dataCta}>
      {label}
    </a>
  );
}

const benefits = [
  {
    title: 'Handle more cases without hiring',
    description: 'Move work forward faster with less admin drag and no extra headcount.',
  },
  {
    title: 'Reply in minutes, not after digging',
    description: 'Get the case context fast, then send clear updates while clients are still waiting.',
  },
  {
    title: 'Give clients faster updates',
    description: 'Show progress quickly and keep clients reassured instead of chasing your team for answers.',
  },
  {
    title: 'Turn inbox chaos into clear actions',
    description: 'See what matters now so every case gets the right next step, quickly.',
  },
];

const howItWorks = [
  {
    step: '1',
    title: 'Open the case in Outlook',
    description: 'CaseLightning sits where your team already works.',
  },
  {
    step: '2',
    title: 'See a clear case summary instantly',
    description: 'Get a simple crib sheet instead of reading long email chains.',
  },
  {
    step: '3',
    title: 'Take the next action fast',
    description: 'Reply to clients, update the case, and move on in minutes.',
  },
];

const faqs = [
  {
    question: 'Is this only for big firms?',
    answer:
      'No. CaseLightning is built for small law firms, conveyancers, and other case-based teams that need speed.',
  },
  {
    question: 'Do we need to change how we work?',
    answer: 'No. Your team works inside Outlook. CaseLightning helps you move faster in the flow you already use.',
  },
  {
    question: 'How quickly will we see value?',
    answer:
      'Most teams feel the time savings in the first week because they stop digging through email threads to find case context.',
  },
  {
    question: 'What if it does not save us time?',
    answer: 'If it does not save you time, do not keep it. You are covered by our money-back guarantee.',
  },
];

export default function Page() {
  return (
    <main className="bg-white text-slate-900">
      <section className="mx-auto max-w-6xl px-6 pb-16 pt-14 md:pb-24 md:pt-20">
        <div className="max-w-4xl">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-600">CaseLightning for busy legal teams</p>
          <h1 className="mt-4 text-4xl font-bold leading-tight md:text-6xl">
            Handle more cases. Reply faster. Make more money.
          </h1>
          <p className="mt-5 max-w-3xl text-lg text-slate-700 md:text-xl">
            CaseLightning turns messy case email threads into a clear case summary and fast next actions inside Outlook,
            so your team can move cases forward without hiring more staff.
          </p>
          <p className="mt-4 text-lg font-semibold text-slate-900">£200/month. Money-back guarantee. Low risk, fast ROI.</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <CtaButton
              label="Book a Demo"
              href={buildCtaHref(CTA_ROUTES.demo, 'hero_book_demo')}
              dataCta="hero-book-demo"
            />
            <CtaButton
              label="Start Free Trial"
              href={buildCtaHref(CTA_ROUTES.trial, 'hero_start_trial')}
              dataCta="hero-start-trial"
              variant="secondary"
            />
            <CtaButton
              label="See How It Works"
              href={buildCtaHref(CTA_ROUTES.howItWorks, 'hero_see_how_it_works')}
              dataCta="hero-see-how-it-works"
              variant="text"
            />
          </div>
        </div>
      </section>

      <section className="border-y border-slate-200 bg-slate-50">
        <div className="mx-auto grid max-w-6xl gap-6 px-6 py-14 md:grid-cols-2">
          <div>
            <h2 className="text-3xl font-bold md:text-4xl">The problem: case work slows down in the inbox</h2>
            <p className="mt-4 text-lg text-slate-700">
              Your team loses time digging through long email chains, chasing updates, and rewriting the same client replies.
              Slow replies frustrate clients and cap how many cases you can handle.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-6">
            <ul className="space-y-3 text-slate-800">
              <li>• Too much time spent searching for case context</li>
              <li>• Client updates go out late</li>
              <li>• Admin work eats into fee-earning time</li>
              <li>• Capacity is stuck unless you hire more people</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16 md:py-24">
        <h2 className="text-3xl font-bold md:text-4xl">What you get with CaseLightning</h2>
        <div className="mt-8 grid gap-5 md:grid-cols-2">
          {benefits.map((benefit) => (
            <article key={benefit.title} className="rounded-2xl border border-slate-200 p-6">
              <h3 className="text-xl font-semibold">{benefit.title}</h3>
              <p className="mt-3 text-slate-700">{benefit.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="bg-slate-900 text-white">
        <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
          <h2 className="text-3xl font-bold md:text-4xl">How it works</h2>
          <p className="mt-4 max-w-3xl text-slate-200">
            No complex setup. Your team gets a clear case view inside Outlook and acts faster right away.
          </p>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {howItWorks.map((item) => (
              <article key={item.step} className="rounded-2xl bg-slate-800 p-6">
                <p className="text-sm font-semibold text-slate-300">Step {item.step}</p>
                <h3 className="mt-2 text-xl font-semibold">{item.title}</h3>
                <p className="mt-3 text-slate-200">{item.description}</p>
              </article>
            ))}
          </div>
          <div className="mt-8">
            <CtaButton
              label="See How It Works"
              href={buildCtaHref(CTA_ROUTES.howItWorks, 'midpage_see_how_it_works')}
              dataCta="midpage-see-how-it-works"
              variant="secondary"
            />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16 md:py-24">
        <h2 className="text-3xl font-bold md:text-4xl">£200/month is tiny next to the upside</h2>
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          <article className="rounded-2xl border border-slate-200 p-6">
            <h3 className="text-xl font-semibold">Speed creates capacity</h3>
            <p className="mt-3 text-slate-700">
              Faster case handling means your current team can take on more matters instead of hitting a workload ceiling.
            </p>
          </article>
          <article className="rounded-2xl border border-slate-200 p-6">
            <h3 className="text-xl font-semibold">Even one extra case can pay for it</h3>
            <p className="mt-3 text-slate-700">
              If CaseLightning helps you handle even one extra case, it pays for itself many times over.
            </p>
          </article>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-10">
        <div className="mx-auto max-w-xl rounded-3xl border-2 border-slate-900 p-8 text-center shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-600">Simple pricing</p>
          <h2 className="mt-3 text-4xl font-bold">£200/month</h2>
          <p className="mt-3 text-slate-700">One flat monthly price to help your team handle more cases and reply faster.</p>
          <p className="mt-5 font-semibold text-slate-900">If it doesn’t save you time, don’t keep it.</p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <CtaButton
              label="Start Free Trial"
              href={buildCtaHref(CTA_ROUTES.trial, 'pricing_start_trial')}
              dataCta="pricing-start-trial"
            />
            <CtaButton
              label="Book a Demo"
              href={buildCtaHref(CTA_ROUTES.demo, 'midpage_book_demo')}
              dataCta="midpage-book-demo"
              variant="secondary"
            />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-10 md:py-14">
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
          <h2 className="text-2xl font-bold md:text-3xl">Money-back guarantee</h2>
          <p className="mt-3 max-w-3xl text-slate-800">
            Try CaseLightning with your real caseload. If it does not help your team save time and move faster, cancel and
            get your money back. No hard feelings.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16 md:py-20">
        <h2 className="text-3xl font-bold md:text-4xl">FAQ</h2>
        <div className="mt-8 space-y-4">
          {faqs.map((item) => (
            <article key={item.question} className="rounded-2xl border border-slate-200 p-6">
              <h3 className="text-lg font-semibold">{item.question}</h3>
              <p className="mt-2 text-slate-700">{item.answer}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="bg-slate-100">
        <div className="mx-auto max-w-6xl px-6 py-16 text-center md:py-24">
          <h2 className="text-3xl font-bold md:text-5xl">Start handling more cases this month</h2>
          <p className="mx-auto mt-4 max-w-3xl text-lg text-slate-700">
            Reply faster, reduce admin, and keep clients happier without adding headcount.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <CtaButton
              label="Book a Demo"
              href={buildCtaHref(CTA_ROUTES.demo, 'footer_book_demo')}
              dataCta="footer-book-demo"
            />
            <CtaButton
              label="Start Free Trial"
              href={buildCtaHref(CTA_ROUTES.trial, 'footer_start_trial')}
              dataCta="footer-start-trial"
              variant="secondary"
            />
          </div>
        </div>
      </section>
    </main>
  );
}
