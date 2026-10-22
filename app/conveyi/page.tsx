import { REFERRALS_ENABLED } from '@/lib/flags';
import type { Metadata } from 'next';
import { ctaHref, ROUTES, Cta, NavHeader, SiteFooter } from '../_components/shared';
import { Vsl } from './Vsl';

export const metadata: Metadata = {
  title: 'CONVEYi — Double your fee earners’ caseload | Case Lightning',
  description:
    'CONVEYi connects to Outlook, InTouch and LEAP and does everything on a conveyancing case that doesn’t need a lawyer: the updating, the chasing, the filing. Pay nothing until your caseload has doubled.',
};

const PAGE_SOURCE = 'landing';

type IconName = 'pound' | 'bank' | 'spoof' | 'log' | 'switch' | 'inbox' | 'people' | 'measure' | 'automate' | 'optimise';

// Hand-rolled line icons: stroked, currentColor, 24px grid.
const ICON_PATHS: Record<IconName, React.ReactNode> = {
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

// Captured from the running app with the local firm the dev seed creates (scripts/dev-seed.ts, dev-book.ts, dev-measure.ts).
const CASEVIEW_SHOT = {
  src: '/product/app-board.webp',
  width: 2300,
  height: 792,
  alt: 'Case View: every live case as a house on a map of stages (instruction, pre-exchange, ready, exchanged, completion) by fee earner, coloured On Track, With Us, Delayed - Others, Delayed - Us or Critical, with the count of each along the top.',
};

const heard: Array<{ icon: IconName; title: string }> = [
  { icon: 'switch', title: 'Switching matters with every email' },
  { icon: 'inbox', title: 'The day goes on chasing and updating' },
  { icon: 'people', title: 'More cases, no more people' },
];

interface Screen { src: string; width: number; height: number; alt: string; phone?: boolean }

const how: Array<{ icon: IconName; title: string; line: string; shot: Screen }> = [
  {
    icon: 'measure',
    title: 'Measure',
    line: 'Where each fee earner’s week goes. That is your baseline.',
    shot: { src: '/product/app-measure-issues.webp', width: 2160, height: 1100, alt: 'The measurement: two months of email sent and received, a typical week split red, amber and green, and a Pareto chart of the work taking the hours, from proactive client updates and status requests down.' },
  },
  {
    icon: 'automate',
    title: 'Automate',
    line: 'Updates, chasers and orders drafted for one click, or sent on their own.',
    shot: { src: '/product/app-automate.webp', width: 1806, height: 1470, alt: 'Tasks on one case: four searches to order and a chaser to the seller’s solicitor, each drafted with an Approve button, and below, what the case is waiting on and when each chase goes.' },
  },
  {
    icon: 'optimise',
    title: 'Optimise',
    line: 'Optimise legal work with AI-powered document review and generation.',
    shot: { src: '/product/app-funds-review.webp', width: 2304, height: 1480, alt: 'A source of funds review: cash paid in, a credit from a cryptoasset exchange and a transfer from an account not provided, each flagged with a query drafted, and the bank statement beside it with the flagged line highlighted.' },
  },
];

const day: Array<{ title: string } & Screen> = [
  {
    title: 'Firm-wide',
    ...CASEVIEW_SHOT,
  },
  {
    title: 'On every case',
    src: '/product/app-case-flow.webp',
    width: 2300,
    height: 1288,
    alt: 'A purchase at pre-completion: identity, source of funds, title, searches, mortgage and contract and exchange done, signing and completion in progress, beside the property, buyer, price, lender, target dates and handler.',
  },
  {
    title: 'For your clients',
    src: '/product/app-portal.webp',
    width: 1170,
    height: 2500,
    phone: true,
    alt: 'A client’s portal on a phone, in a made-up firm’s logo and colour: the parts of their purchase side by side, done, with the client, or in progress, and the enquiries with the seller’s solicitor, usually two weeks a round, expected by a date.',
  },
];

const safety: Array<{ icon: IconName; title: string }> = [
  { icon: 'pound', title: 'A person signs off money' },
  { icon: 'bank', title: 'Bank details verified by phone' },
  { icon: 'spoof', title: 'Spoofed senders caught' },
  { icon: 'log', title: 'Every step recorded' },
];

function Shot({ src, alt, width, height, phone = false }: { src: string; alt: string; width: number; height: number; phone?: boolean }) {
  return (
    <figure className={phone ? 'mx-auto w-full max-w-[300px]' : ''}>
      <div className={`overflow-hidden border bg-white shadow-card ${phone ? 'rounded-[2rem] border-[6px] border-ink/90' : 'rounded-xl border-line'}`}>
        <img src={src} alt={alt} width={width} height={height} className="block h-auto w-full" />
      </div>
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

      {/* ── HERO ── the promise from the ads and the emails, word for word, beside the video. */}
      <section className="px-6 pt-10 pb-14 md:pt-16 md:pb-20">
        <div className="mx-auto grid max-w-6xl items-center gap-10 md:grid-cols-[1fr_1.15fr] md:gap-12">
          <div>
            <h1 className="font-serif text-[2.6rem] font-semibold leading-[1.04] tracking-tight sm:text-6xl md:text-[3.4rem] lg:text-6xl">
              Double your fee earners’ caseload.
              <span className="block italic text-violet">Pay nothing until we do.</span>
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-ink-soft md:text-xl">
              The updating, chasing and filing on every case, done. Works with Outlook, InTouch and LEAP.
            </p>
            <div className="mt-7">
              <Actions where="hero" />
            </div>
          </div>
          <Vsl sources={[{ src: '/product/vsl-v8.mp4', type: 'video/mp4' }, { src: '/product/vsl-v8.webm', type: 'video/webm' }]} poster="/product/vsl-poster-3.webp" label="CONVEYi in 43 seconds" />
        </div>
      </section>

      {/* ── WHAT WE HEAR ── */}
      <section className="border-t border-line bg-paper-soft px-6 py-14 md:py-16">
        <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-[auto_1fr] md:items-center md:gap-16">
          <h2 className="font-serif text-3xl font-semibold leading-tight tracking-tight md:text-4xl">What we hear</h2>
          <ul className="grid gap-6 sm:grid-cols-3">
            {heard.map((h) => (
              <li key={h.title} className="flex items-center gap-3">
                <span className="shrink-0 text-violet"><Icon name={h.icon} /></span>
                <span className="text-lg font-semibold leading-snug">{h.title}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── HOW IT WORKS ── a real sequence, so it is numbered by its order. */}
      <section className="border-t border-line px-6 py-20 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">How it works</h2>
          <ol className="mt-12 grid gap-16 md:gap-20">
            {how.map((h, i) => (
              <li key={h.title} className={`grid items-center gap-8 md:gap-12 ${i % 2 ? 'md:grid-cols-[2fr_1fr]' : 'md:grid-cols-[1fr_2fr]'}`}>
                <div className={i % 2 ? 'md:order-2' : ''}>
                  <div className="flex items-center gap-3 text-violet">
                    <Icon name={h.icon} />
                    <span className="text-sm font-semibold uppercase tracking-[0.18em]">Step {i + 1}</span>
                  </div>
                  <h3 className="mt-3 font-serif text-3xl font-semibold tracking-tight md:text-4xl">{h.title}</h3>
                  <p className="mt-3 text-lg text-ink-soft">{h.line}</p>
                </div>
                <Shot {...h.shot} />
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── THE PRODUCT ── */}
      <section className="border-t border-line bg-paper-soft px-6 py-20 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">Updates at a glance</h2>
          <div className="mt-12 grid items-start gap-14 md:grid-cols-[2fr_1fr] md:gap-12">
            {day.map((d, i) => (
              <div key={d.title} className={i === 0 ? 'md:col-span-2' : ''}>
                <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">{d.title}</h3>
                <div className="mt-4"><Shot src={d.src} alt={d.alt} width={d.width} height={d.height} phone={d.phone} /></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SAFETY ── */}
      <section className="bg-ink px-6 py-16 text-paper md:py-20">
        <div className="mx-auto max-w-6xl">
          <h2 className="max-w-3xl font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            Built for the sector fraudsters target most
          </h2>
          <ul className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {safety.map((s) => (
              <li key={s.title} className="flex items-center gap-3">
                <span className="shrink-0 text-violet-soft"><Icon name={s.icon} /></span>
                <span className="text-lg font-semibold leading-snug">{s.title}</span>
              </li>
            ))}
          </ul>
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
          <p className="mt-4 max-w-2xl text-lg text-ink-soft">Measured against completions per fee earner before you start.</p>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            <div className="rounded-2xl border-2 border-violet bg-paper-soft p-8 shadow-violet">
              <div className="text-sm font-semibold uppercase tracking-widest text-violet">Until it has doubled</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£0</div>
              <p className="mt-3 text-ink-soft">Everything, every case.</p>
            </div>
            <div className="rounded-2xl border border-line bg-paper-soft p-8">
              <div className="text-sm font-semibold uppercase tracking-widest text-ink-soft">Then, per case</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£80<span className="font-sans text-lg font-normal text-ink-soft">/case + VAT</span></div>
              <p className="mt-3 text-ink-soft">Once per case.</p>
            </div>
            <div className="rounded-2xl border border-line bg-paper-soft p-8">
              <div className="text-sm font-semibold uppercase tracking-widest text-ink-soft">Seats and monthly fee</div>
              <div className="mt-3 font-serif text-5xl font-semibold">£0</div>
              <p className="mt-3 text-ink-soft">Everyone in the firm.</p>
            </div>
          </div>
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
