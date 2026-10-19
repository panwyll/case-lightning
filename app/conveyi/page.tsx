import { REFERRALS_ENABLED } from '@/lib/flags';
import type { Metadata } from 'next';
import { ctaHref, ROUTES, Cta, NavHeader, SiteFooter } from '../_components/shared';

export const metadata: Metadata = {
  title: 'CONVEYi — Every case keeps moving | Case Lightning',
  description:
    'CONVEYi reads every email and document, keeps each conveyancing case moving and does the chasing. Your team is left with the decisions. Works with LEAP, InTouch and Outlook. £80 + VAT per case.',
};

const PAGE_SOURCE = 'landing';

type IconName = 'chase' | 'receipt' | 'update' | 'file' | 'pound' | 'bank' | 'spoof' | 'log';

// Hand-rolled line icons: stroked, currentColor, 24px grid.
const ICON_PATHS: Record<IconName, React.ReactNode> = {
  chase: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2.5M9 2h6" />
    </>
  ),
  receipt: (
    <>
      <path d="M4 6h16v12H4z" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  update: (
    <>
      <path d="M21 12a8 8 0 0 1-11.8 7L4 20l1-5.2A8 8 0 1 1 21 12z" />
      <path d="M9 11h6M9 14h4" />
    </>
  ),
  file: (
    <>
      <path d="M3 7h6l2 2h10v10H3z" />
      <path d="m9 14 2 2 4-4" />
    </>
  ),
  pound: <path d="M16 6.5A4 4 0 0 0 8.5 8v12M6 13h7M6 20h11" />,
  bank: <path d="M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" />,
  spoof: (
    <>
      <path d="M12 3l7 3v5.2c0 4.4-2.9 8-7 9.8-4.1-1.8-7-5.4-7-9.8V6l7-3z" />
      <path d="M12 8v4M12 15.5v.01" />
    </>
  ),
  log: (
    <>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M9 9h6M9 13h6M9 17h3" />
    </>
  ),
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-6 w-6"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

// Captured from the running app with the demo firm the dev seed creates, so every name,
// address and figure on them is made up; each carries a caption saying so.
const TASKS_SHOT = {
  src: '/product/app-tasks.webp',
  alt: 'The Tasks list: cases grouped by property, each task labelled by kind (Client Request, Seller’s Solicitor Request, Upload Documents, Record Outcome) with Approve, Review or a single action button.',
};

const day: Array<{ title: string; body: string; src: string; alt: string }> = [
  {
    title: 'Every case at a glance',
    body: 'What is done, what is waiting and on whom, from ID checks through searches, title and mortgage to exchange and completion.',
    src: '/product/app-case.webp',
    alt: 'A purchase at 14 Oak Street, Leeds: the case’s stages as a flow (ID and AML, source of funds, title, searches, survey, mortgage, enquiries) with progress on each, beside the property, buyer, price, handler and contacts.',
  },
  {
    title: 'The firm in numbers',
    body: 'Completions, fee income and days to complete, against your target, last year and the industry.',
    src: '/product/app-analytics.webp',
    alt: 'Analytics: completions this month against target, fee income, instructions, days to complete, client satisfaction and a chart of completions by month.',
  },
];

const unasked: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'chase', title: 'Chasing', body: 'The other side, the lender, the client. When a reply is late, the chase goes.' },
  { icon: 'receipt', title: 'Receipt Acknowledgements', body: 'What arrives is acknowledged, so nobody rings to ask if it got through.' },
  { icon: 'update', title: 'Client And Agent Updates', body: 'Written from the case at each milestone, in plain English.' },
  { icon: 'file', title: 'Email Filed To The Case', body: 'Every email and attachment is read, filed to its case, and moves the case on.' },
];

const safety: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'pound', title: 'A Person Signs Off Money', body: 'Exchange, completion and client decisions are recorded by a person. The database refuses them from automation.' },
  { icon: 'bank', title: 'Bank Details Verified Out Of Band', body: 'Bank details that arrive by email stay unverified until a person confirms them by phone.' },
  { icon: 'spoof', title: 'Spoofed Senders Caught', body: 'Forged senders, look-alike domains and diverted replies are flagged before anyone acts on them.' },
  { icon: 'log', title: 'Everything Recorded', body: 'Every step, who or what took it, and the document it came from.' },
];

function Shot({ src, alt }: { src: string; alt: string }) {
  return (
    <figure>
      <div className="overflow-hidden rounded-xl border border-line bg-white shadow-card">
        <img src={src} alt={alt} width={2760} height={1600} className="block h-auto w-full" />
      </div>
      <figcaption className="mt-2 text-xs text-ink-soft">Demo firm. Names, addresses and figures are made up.</figcaption>
    </figure>
  );
}

export default function Page() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      {/* ── HERO ── */}
      <section className="px-6 pt-16 pb-16 md:pt-24 md:pb-20">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-4xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">Conveyancing case management</p>
            <h1 className="mt-5 font-serif text-5xl font-semibold leading-[1.02] tracking-tight md:text-7xl">
              Every case keeps moving.
              <span className="block italic text-violet">Only the decisions are left for you.</span>
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-relaxed text-ink-soft md:text-xl">
              CONVEYi reads every email and document, keeps each case on track and does the chasing. Works with LEAP,
              InTouch and Outlook. Nothing to migrate.
            </p>
            <div className="mt-9 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <Cta label="Get Started" href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'hero_signup')} dataCta="hero_signup" size="lg" />
              <span className="text-sm text-ink-soft">£80 + VAT per case · no seat or monthly fees</span>
            </div>
          </div>
          <div className="mt-14 md:mt-16">
            <Shot {...TASKS_SHOT} />
          </div>
        </div>
      </section>

      {/* ── THE DAY ── */}
      <section className="border-t border-line bg-paper-soft px-6 py-20 md:py-24">
        <div className="mx-auto grid max-w-6xl gap-16 md:gap-20">
          {day.map((d, i) => (
            <div key={d.title} className={`grid items-center gap-8 md:gap-12 ${i % 2 ? 'md:grid-cols-[1.8fr_1fr]' : 'md:grid-cols-[1fr_1.8fr]'}`}>
              <div className={i % 2 ? 'md:order-2' : ''}>
                <h2 className="font-serif text-3xl font-semibold leading-tight tracking-tight md:text-4xl">{d.title}</h2>
                <p className="mt-4 text-lg text-ink-soft">{d.body}</p>
              </div>
              <Shot src={d.src} alt={d.alt} />
            </div>
          ))}
        </div>
      </section>

      {/* ── WITHOUT BEING ASKED ── */}
      <section className="border-t border-line px-6 py-20 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="max-w-3xl font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            Done without being asked
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-ink-soft">
            You choose, for each kind of message, whether it goes on its own or waits on your Tasks list for one click.
          </p>
          <div className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {unasked.map((u) => (
              <div key={u.title}>
                <span className="text-violet"><Icon name={u.icon} /></span>
                <h3 className="mt-4 text-lg font-bold leading-tight">{u.title}</h3>
                <p className="mt-2 text-ink-soft">{u.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SAFETY ── */}
      <section className="bg-ink px-6 py-20 text-paper md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="max-w-3xl font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            Built for the sector fraudsters target most
          </h2>
          <div className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {safety.map((s) => (
              <div key={s.title}>
                <span className="text-violet-soft"><Icon name={s.icon} /></span>
                <h3 className="mt-4 text-lg font-bold leading-tight">{s.title}</h3>
                <p className="mt-2 text-paper/70">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── REFERRAL ── (parked: lib/flags.ts) */}
      {REFERRALS_ENABLED && (
      <section className="px-6 py-20 md:py-28">
        <div className="mx-auto max-w-4xl rounded-3xl border border-violet/20 bg-violet-soft p-10 md:p-14">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">The best referral scheme in legal software</p>
          <h2 className="mt-4 font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            Refer a firm, earn <span className="italic text-violet">£10 on every case</span> they run.
          </h2>
          <p className="mt-5 max-w-2xl text-lg text-ink-soft">
            Not a one-off finder’s fee — £10 in account credit for every case a firm you refer is billed for,
            for as long as they’re a customer. Refer a handful and your own subscription pays for itself.
          </p>
        </div>
      </section>
      )}

      {/* ── PRICING ── */}
      <section className="px-6 py-20 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="font-serif text-4xl font-semibold tracking-tight md:text-5xl">£80 per case. Nothing else.</h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            <div className="rounded-2xl border-2 border-violet bg-paper-soft p-8 shadow-violet">
              <div className="text-sm font-semibold uppercase tracking-widest text-violet">Per case</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£80<span className="font-sans text-lg font-normal text-ink-soft">/case + VAT</span></div>
              <p className="mt-3 text-ink-soft">Charged once, the first time CONVEYi works on a case.</p>
            </div>
            <div className="rounded-2xl border border-line bg-paper-soft p-8">
              <div className="text-sm font-semibold uppercase tracking-widest text-ink-soft">Seats</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£0<span className="font-sans text-lg font-normal text-ink-soft">/seat</span></div>
              <p className="mt-3 text-ink-soft">Everyone in the firm.</p>
            </div>
            <div className="rounded-2xl border border-line bg-paper-soft p-8">
              <div className="text-sm font-semibold uppercase tracking-widest text-ink-soft">Monthly fee</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£0<span className="font-sans text-lg font-normal text-ink-soft">/mo</span></div>
              <p className="mt-3 text-ink-soft">A quiet month costs nothing.</p>
            </div>
          </div>
          <p className="mt-6 text-sm text-ink-soft">
            30-day money-back guarantee ·{' '}
            <a href={ctaHref(ROUTES.pricing, PAGE_SOURCE, 'pricing_details')} data-cta="pricing_details" className="underline underline-offset-4 hover:text-ink">
              Pricing Details
            </a>
          </p>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="border-t border-line bg-paper-soft px-6 py-20 md:py-24">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <h2 className="max-w-2xl font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            Same team. More cases.
          </h2>
          <Cta label="Get Started" href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'footer_signup')} dataCta="footer_signup" size="lg" />
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
