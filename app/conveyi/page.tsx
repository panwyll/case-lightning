import { REFERRALS_ENABLED } from '@/lib/flags';
import type { Metadata } from 'next';
import { ctaHref, ROUTES, Cta, NavHeader, SiteFooter } from '../_components/shared';
import { Vsl } from './Vsl';

export const metadata: Metadata = {
  title: 'CONVEYi — Double the cases without double the work | Case Lightning',
  description:
    'CONVEYi connects to Outlook, InTouch and LEAP and does everything on a conveyancing case that doesn’t need a lawyer: the updating, the chasing, the filing. Pay nothing until your team handles double the cases.',
};

const PAGE_SOURCE = 'landing';

type IconName = 'pound' | 'bank' | 'spoof' | 'log';

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


interface Screen { src: string; width: number; height: number; alt: string; phone?: boolean }

const how: Array<{ title: string; line: string; shot: Screen }> = [
  {
    title: 'Measure',
    line: 'See where your team’s week goes, and how much of it is being lost.',
    shot: { src: '/product/app-measure-issues.webp', width: 2160, height: 1100, alt: 'The measurement: two months of email sent and received, a typical week split red, amber and green, and a Pareto chart of the work taking the hours, from proactive client updates and status requests down.' },
  },
  {
    title: 'Automate',
    line: 'Set up around how you work in as little as an afternoon. Updates, chasers and orders drafted for one click, or sent on their own.',
    shot: { src: '/product/app-automate.webp', width: 1806, height: 1470, alt: 'Tasks on one case: four searches to order and a chaser to the seller’s solicitor, each drafted with an Approve button, and below, what the case is waiting on and when each chase goes.' },
  },
  {
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

const questions: Array<{ q: string; a: string }> = [
  { q: 'Will it send something wrong?', a: 'Nothing goes on its own until you switch that kind of message on. Exchange, completion and money always need a person.' },
  { q: 'Do we have to change systems?', a: 'No. It works on the Outlook, InTouch and LEAP you already use. Nothing to migrate.' },
  { q: 'Where does our data go?', a: 'Your emails and documents stay in your own Microsoft 365.' },
  { q: 'What if we don’t double our capacity?', a: 'Then you don’t pay. We measure your firm’s capacity before you start, and it’s free until that has doubled.' },
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

/** One action on this page: book a demo. */
function BookDemo({ where, onColour = false, size = 'lg' }: { where: string; onColour?: boolean; size?: 'lg' | 'xl' }) {
  return <Cta label="Book A Demo" href={ctaHref(ROUTES.demo, PAGE_SOURCE, `${where}_demo`)} dataCta={`${where}_demo`} variant={onColour ? 'onColour' : 'primary'} size={size} />;
}

export default function Page() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.demo, PAGE_SOURCE, 'nav_demo')} signupLabel="Book A Demo" />

      {/* ── HERO ── the promise and the button; then the doubt, said out loud, and the way down to the answer.
          Measured as drawn (ink to ink), not as boxes: 64 above and below the button; 16 from the prompt to Let Us Explain,
          20 to the arrow at rest. Type: headline 72, prompt 24, button 20, link 16. */}
      <section className="flex min-h-[calc(100svh-69px)] flex-col justify-center px-6 py-12">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center text-center">
          <h1 className="font-serif text-[2.35rem] font-bold leading-[1.04] tracking-tight sm:text-6xl lg:text-[4.25rem] xl:text-[4.5rem]">
            <span className="block whitespace-nowrap uppercase">Double the cases</span>
            <span className="block uppercase italic text-violet [text-wrap:balance] lg:whitespace-nowrap">without double the work</span>
          </h1>
          <div className="mt-[53px]">
            <BookDemo where="hero" size="xl" />
          </div>
          <div className="mt-16 flex flex-col items-center">
            <p className="font-serif text-xl font-bold uppercase leading-none tracking-tight md:text-2xl">Sound too good to be true?</p>
            <a href="#explain" className="mt-[11px] inline-flex flex-col items-center gap-2.5 text-sm font-bold uppercase leading-none tracking-[0.14em] text-violet md:mt-0.5 md:gap-1.5 md:text-base" data-cta="hero_explain">
              Let us explain
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="motion-safe:animate-bounce"><path d="m6 9 6 6 6-6" /></svg>
            </a>
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── the explanation: plugged in in an afternoon, then a real sequence, then the guarantee and the ask. */}
      <section id="explain" className="scroll-mt-16 bg-ink px-6 py-20 text-paper md:py-28">
        <div className="mx-auto max-w-6xl">
          <h2 className="font-serif text-4xl font-bold leading-tight tracking-tight md:text-5xl">How it works</h2>
          <p className="mt-4 max-w-2xl text-xl leading-relaxed text-paper/75">Find out how much time your team could save, on a 15-minute demo.</p>
          <ol className="mt-14 grid gap-16 md:gap-24">
            {how.map((h, i) => (
              <li key={h.title} className={`grid items-center gap-8 md:gap-12 ${i % 2 ? 'md:grid-cols-[2fr_1fr]' : 'md:grid-cols-[1fr_2fr]'}`}>
                <div className={i % 2 ? 'md:order-2' : ''}>
                  <h3 className="font-serif text-3xl font-bold tracking-tight md:text-4xl"><span className="text-[#9B7BFF]">{i + 1}.</span> {h.title}</h3>
                  <p className="mt-3 text-lg leading-relaxed text-paper/75">{h.line}</p>
                </div>
                <Shot {...h.shot} />
              </li>
            ))}
          </ol>
          <div className="mt-24 flex flex-col items-center border-t border-white/10 pt-20 text-center">
            <p className="max-w-3xl font-serif text-3xl font-bold leading-tight tracking-tight [text-wrap:balance] md:text-5xl">It’s free until we’ve doubled your capacity.</p>
            <p className="mt-5 text-xl text-paper/75 md:text-2xl">Let us prove it first. Then we’ll talk.</p>
            <p className="mt-12 font-serif text-xl font-bold uppercase tracking-tight md:text-2xl">Sound good?</p>
            <div className="mt-6">
              <BookDemo where="guarantee" size="xl" />
            </div>
          </div>
        </div>
      </section>

      {/* ── THE VIDEO ── */}
      <section className="border-b border-line bg-paper-soft px-6 py-20 md:py-24">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-center font-serif text-4xl font-bold leading-tight tracking-tight md:text-5xl">See it in 43 seconds</h2>
          <div className="mt-10">
            <Vsl sources={[{ src: '/product/vsl-v15.mp4', type: 'video/mp4' }, { src: '/product/vsl-v15.webm', type: 'video/webm' }]} poster="/product/vsl-poster-5.webp" label="CONVEYi in 43 seconds" />
          </div>
        </div>
      </section>

      {/* ── THE PRODUCT ── */}
      <section className="bg-violet px-6 py-20 text-white md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="font-serif text-4xl font-bold leading-tight tracking-tight md:text-5xl">Updates at a glance</h2>
          <div className="mt-12 grid items-start gap-14 md:grid-cols-[2fr_1fr] md:gap-12">
            {day.map((d, i) => (
              <div key={d.title} className={i === 0 ? 'md:col-span-2' : ''}>
                <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-white/75">{d.title}</h3>
                <div className="mt-4"><Shot src={d.src} alt={d.alt} width={d.width} height={d.height} phone={d.phone} /></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SAFETY ── */}
      <section className="bg-ink px-6 py-16 text-paper md:py-20">
        <div className="mx-auto max-w-6xl">
          <h2 className="max-w-3xl font-serif text-4xl font-bold leading-tight tracking-tight md:text-5xl">
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
          <h2 className="mt-4 font-serif text-4xl font-bold leading-tight tracking-tight md:text-5xl">
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
          <h2 className="max-w-4xl font-serif text-4xl font-bold tracking-tight md:text-5xl">Pay nothing until your team handles double the cases.</h2>
          <p className="mt-4 max-w-2xl text-lg text-ink-soft">Measured across the firm before you start. Never one person’s figures.</p>
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

      {/* ── QUESTIONS ── the objections, answered in the open. */}
      <section className="border-t border-line bg-paper-soft px-6 py-20 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="font-serif text-4xl font-bold leading-tight tracking-tight md:text-5xl">Questions</h2>
          <dl className="mt-10 grid gap-x-12 gap-y-8 md:grid-cols-2">
            {questions.map((x) => (
              <div key={x.q}>
                <dt className="text-xl font-bold">{x.q}</dt>
                <dd className="mt-2 text-lg text-ink-soft">{x.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="bg-violet px-6 py-20 text-white md:py-24">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <div>
            <h2 className="max-w-2xl font-serif text-4xl font-bold leading-tight tracking-tight md:text-5xl">Same team. Double the cases.</h2>
            <p className="mt-4 max-w-xl text-lg text-white/80">15 minutes on cases like yours, and how we would measure your baseline.</p>
          </div>
          <BookDemo where="footer" onColour />
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
