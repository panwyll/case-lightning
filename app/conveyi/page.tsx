import { REFERRALS_ENABLED } from '@/lib/flags';
import type { Metadata } from 'next';
import { ctaHref, ROUTES, Cta, NavHeader, SiteFooter } from '../_components/shared';

export const metadata: Metadata = {
  title: 'CONVEYi — Double your fee earners’ caseload | Case Lightning',
  description:
    'CONVEYi connects to Outlook, InTouch and LEAP and does everything on a conveyancing case that doesn’t need a lawyer: the updating, the chasing, the filing. Pay nothing until your caseload has doubled.',
};

const PAGE_SOURCE = 'landing';

type IconName = 'chase' | 'receipt' | 'update' | 'file' | 'pound' | 'bank' | 'spoof' | 'log' | 'switch' | 'inbox' | 'people' | 'measure' | 'automate' | 'optimise';

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
  switch: <path d="M4 8h13l-3-3M20 16H7l3 3" />,
  inbox: (
    <>
      <path d="M3 13l3-8h12l3 8v6H3z" />
      <path d="M3 13h5l1.5 2h5L16 13h5" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M16 5.5a3 3 0 0 1 0 5.5M18 14.5c1.8.9 3 2.9 3 5.5" />
    </>
  ),
  measure: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  automate: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v4h-4" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  optimise: (
    <>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
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

// Captured from the running app with the demo firm the dev seed creates (scripts/dev-seed.ts, scripts/dev-book.ts),
// so every name, address and figure on them is made up; each carries a caption saying so.
const CASEVIEW_SHOT = {
  src: '/product/app-caseview.webp',
  width: 2760,
  height: 1270,
  alt: 'Case View: every live case as a house on a map of stages (instruction, pre-exchange, ready, exchanged, completion) by fee earner, coloured On Track, With Us, Delayed - Others, Delayed - Us or Critical, with the count of each along the top.',
};

const heard: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'switch', title: 'Switching between matters all day', body: 'Every email means finding your place on another case.' },
  { icon: 'inbox', title: 'Updating and chasing, not legal work', body: 'Most of the day goes on chasers, “any news?” replies, acknowledgements and filing.' },
  { icon: 'people', title: 'Fewer firms, more transactions', body: 'The work per fee earner keeps growing, and hiring does not keep up.' },
];

const how: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'measure', title: 'Measure', body: 'We read the last three months of each fee earner’s inbox and case system and show where the week actually goes: the chasers, the status updates, the acknowledgements, and the hours they add up to. That is your baseline.' },
  { icon: 'automate', title: 'Automate', body: 'CONVEYi reads and files every email and document to the right case, and sends the chasers, acknowledgements and client and agent updates when they are due. Each fee earner gets one list of only what needs them.' },
  { icon: 'optimise', title: 'Optimise', body: 'Every week you see the time that is left, what is taking it and what to switch on next, with completions per fee earner tracked against your baseline.' },
];

const unasked: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'chase', title: 'Chasing', body: 'The other side, the lender, the client. When a reply is late, the chase goes.' },
  { icon: 'receipt', title: 'Receipt Acknowledgements', body: 'What arrives is acknowledged, so nobody rings to ask if it got through.' },
  { icon: 'update', title: 'Client And Agent Updates', body: 'Written from the case at each milestone, in plain English.' },
  { icon: 'file', title: 'Email Filed To The Case', body: 'Every email and attachment is read, filed to its case, and moves the case on.' },
];

const day: Array<{ title: string; body: string; src: string; width: number; height: number; alt: string; phone?: boolean }> = [
  {
    title: 'Every case at a glance',
    body: 'What is done, what is waiting and on whom, from ID checks through searches, title and mortgage to exchange and completion.',
    src: '/product/app-case.webp',
    width: 2760,
    height: 1600,
    alt: 'A purchase at pre-completion: identity, source of funds, title, searches, mortgage and contract and exchange done, signing and completion in progress, beside the property, buyer, price, lender, target dates and handler.',
  },
  {
    title: 'A portal in your firm’s name',
    body: 'Clients see what they need to do, where things stand, who has each part and how long it usually takes, so they stop ringing to ask. Your logo, your colours, your address.',
    src: '/product/app-portal.webp',
    width: 1170,
    height: 2500,
    phone: true,
    alt: 'A client’s portal on a phone, in a made-up firm’s logo and colour: the parts of their purchase side by side, done, with the client, or in progress, and the enquiries with the seller’s solicitor, usually two weeks a round, expected by a date.',
  },
  {
    title: 'The firm in numbers',
    body: 'Completions, fee income and days to complete, against your target, last year and the industry.',
    src: '/product/app-analytics.webp',
    width: 2760,
    height: 1600,
    alt: 'Analytics: completions this month against target, fee income, instructions, days to complete, client satisfaction and a chart of completions by month.',
  },
];

const safety: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'pound', title: 'A Person Signs Off Money', body: 'Exchange, completion and client decisions are recorded by a person. The database refuses them from automation.' },
  { icon: 'bank', title: 'Bank Details Verified Out Of Band', body: 'Bank details that arrive by email stay unverified until a person confirms them by phone.' },
  { icon: 'spoof', title: 'Spoofed Senders Caught', body: 'Forged senders, look-alike domains and diverted replies are flagged before anyone acts on them.' },
  { icon: 'log', title: 'Everything Recorded', body: 'Every step, who or what took it, and the document it came from.' },
];

function Shot({ src, alt, width, height, phone = false }: { src: string; alt: string; width: number; height: number; phone?: boolean }) {
  return (
    <figure className={phone ? 'mx-auto w-full max-w-[300px]' : ''}>
      <div className={`overflow-hidden border bg-white shadow-card ${phone ? 'rounded-[2rem] border-[6px] border-ink/90' : 'rounded-xl border-line'}`}>
        <img src={src} alt={alt} width={width} height={height} className="block h-auto w-full" />
      </div>
      <figcaption className={`mt-2 text-xs text-ink-soft ${phone ? 'text-center' : ''}`}>Demo firm. Names, addresses and figures are made up.</figcaption>
    </figure>
  );
}

function Actions({ where, dark = false }: { where: string; dark?: boolean }) {
  return (
    <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
      <Cta label="Book A 15-Minute Demo" href={ctaHref(ROUTES.demo, PAGE_SOURCE, `${where}_demo`)} dataCta={`${where}_demo`} size="lg" />
      <Cta label="Get Started" href={ctaHref(ROUTES.signup, PAGE_SOURCE, `${where}_signup`)} dataCta={`${where}_signup`} variant="secondary" size="lg" className={dark ? 'border-paper/30 text-paper hover:bg-paper hover:text-ink' : ''} />
    </div>
  );
}

export default function Page() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      {/* ── HERO ── the promise from the ads and the emails, word for word. */}
      <section className="px-6 pt-10 pb-14 md:pt-20 md:pb-20">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-4xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">For conveyancing firms</p>
            <h1 className="mt-4 font-serif text-[2.6rem] font-semibold leading-[1.04] tracking-tight sm:text-6xl md:mt-5 md:text-7xl">
              Double your fee earners’ caseload.
              <span className="block italic text-violet">Pay nothing until we do.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-soft md:mt-7 md:text-xl">
              CONVEYi connects to Outlook, InTouch and LEAP and does everything on a case that doesn’t need a lawyer:
              the updating, the chasing, the filing. Every case keeps moving. Only the decisions are left for you.
            </p>
            <div className="mt-8 md:mt-9">
              <Actions where="hero" />
            </div>
            <p className="mt-4 text-sm text-ink-soft">£80 + VAT per case once your caseload has doubled · no seat or monthly fees · nothing to migrate</p>
          </div>
          <div className="mt-12 md:mt-16">
            <Shot {...CASEVIEW_SHOT} />
          </div>
        </div>
      </section>

      {/* ── WHAT WE HEAR ── */}
      <section className="border-t border-line bg-paper-soft px-6 py-20 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="max-w-3xl font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">What we hear from conveyancers</h2>
          <div className="mt-12 grid gap-10 md:grid-cols-3">
            {heard.map((h) => (
              <div key={h.title}>
                <span className="text-violet"><Icon name={h.icon} /></span>
                <h3 className="mt-4 text-xl font-bold leading-tight">{h.title}</h3>
                <p className="mt-2 text-lg text-ink-soft">{h.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── a real sequence, so it is numbered by its order. */}
      <section className="border-t border-line px-6 py-20 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="max-w-3xl font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">How it works</h2>
          <ol className="mt-12 grid gap-10 md:grid-cols-3">
            {how.map((h, i) => (
              <li key={h.title} className="border-t-2 border-violet pt-6">
                <div className="flex items-center gap-3 text-violet">
                  <Icon name={h.icon} />
                  <span className="text-sm font-semibold uppercase tracking-[0.18em]">Step {i + 1}</span>
                </div>
                <h3 className="mt-4 font-serif text-3xl font-semibold tracking-tight">{h.title}</h3>
                <p className="mt-3 text-lg text-ink-soft">{h.body}</p>
              </li>
            ))}
          </ol>
          <div className="mt-16 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {unasked.map((u) => (
              <div key={u.title}>
                <span className="text-violet"><Icon name={u.icon} /></span>
                <h3 className="mt-4 text-lg font-bold leading-tight">{u.title}</h3>
                <p className="mt-2 text-ink-soft">{u.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-10 max-w-2xl text-ink-soft">You choose, for each kind of message, whether it goes on its own or waits on your Tasks list for one click.</p>
        </div>
      </section>

      {/* ── THE PRODUCT ── */}
      <section className="border-t border-line bg-paper-soft px-6 py-20 md:py-24">
        <div className="mx-auto grid max-w-6xl gap-16 md:gap-24">
          {day.map((d, i) => (
            <div key={d.title} className={`grid items-center gap-8 md:gap-12 ${d.phone ? 'md:grid-cols-2' : i % 2 ? 'md:grid-cols-[1.8fr_1fr]' : 'md:grid-cols-[1fr_1.8fr]'}`}>
              <div className={i % 2 ? 'md:order-2' : ''}>
                <h2 className="font-serif text-3xl font-semibold leading-tight tracking-tight md:text-4xl">{d.title}</h2>
                <p className="mt-4 text-lg text-ink-soft">{d.body}</p>
              </div>
              <Shot src={d.src} alt={d.alt} width={d.width} height={d.height} phone={d.phone} />
            </div>
          ))}
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

      {/* ── PRICING ── the guarantee first, then what it costs after. */}
      <section className="px-6 py-20 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="max-w-4xl font-serif text-4xl font-semibold tracking-tight md:text-5xl">Pay nothing until we double your caseload.</h2>
          <p className="mt-5 max-w-2xl text-lg text-ink-soft">
            Before you start, we measure each fee earner’s caseload. CONVEYi is free until completions per fee earner have
            doubled against that baseline. After that, it is £80 + VAT per case, and nothing else.
          </p>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            <div className="rounded-2xl border-2 border-violet bg-paper-soft p-8 shadow-violet">
              <div className="text-sm font-semibold uppercase tracking-widest text-violet">Until it has doubled</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£0</div>
              <p className="mt-3 text-ink-soft">The whole product, for the whole firm, on every case.</p>
            </div>
            <div className="rounded-2xl border border-line bg-paper-soft p-8">
              <div className="text-sm font-semibold uppercase tracking-widest text-ink-soft">Then, per case</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£80<span className="font-sans text-lg font-normal text-ink-soft">/case + VAT</span></div>
              <p className="mt-3 text-ink-soft">Charged once, the first time CONVEYi works on a case.</p>
            </div>
            <div className="rounded-2xl border border-line bg-paper-soft p-8">
              <div className="text-sm font-semibold uppercase tracking-widest text-ink-soft">Seats and monthly fee</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£0</div>
              <p className="mt-3 text-ink-soft">Everyone in the firm. A quiet month costs nothing.</p>
            </div>
          </div>
          <p className="mt-6 text-sm text-ink-soft">
            <a href={ctaHref(ROUTES.pricing, PAGE_SOURCE, 'pricing_details')} data-cta="pricing_details" className="underline underline-offset-4 hover:text-ink">
              Pricing Details
            </a>
          </p>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="bg-ink px-6 py-20 text-paper md:py-24">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <h2 className="max-w-2xl font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            Same team. Twice the cases.
          </h2>
          <Actions where="footer" dark />
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
