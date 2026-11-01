import { REFERRALS_ENABLED } from '@/lib/flags';
import type { Metadata } from 'next';
import { ctaHref, ROUTES, Cta, NavHeader, SiteFooter } from '../_components/shared';
import { Vsl } from './Vsl';
import { SCREEN_ZOOM, Tilt } from './Tilt';

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

/** The measurement: a typical week across the firm, and the work taking it (Key Issues). */
const MEASURE_SHOT: Screen = { src: '/product/app-measure-v3.webp', width: 2160, height: 1100, alt: 'The measurement: two months of email sent and received, a typical week split red, amber and green, and a Pareto chart of the work taking the hours, from proactive client updates and status requests down.' };

const how: Array<{ title: string; line: string; shot: Screen }> = [
  {
    title: 'Save time',
    line: 'Emails filed to the right case. Chasers, client updates and searches drafted for one click, or sent on their own. Documents reviewed, with every point shown in the document.',
    shot: { src: '/product/app-automate.webp', width: 1806, height: 1470, alt: 'Tasks on one case: four searches to order and a chaser to the seller’s solicitor, each drafted with an Approve button, and below, what the case is waiting on and when each chase goes.' },
  },
  {
    title: 'Save headspace',
    line: 'Every case, what’s done, what’s next and who it’s waiting on, in one view. CONVEYi keeps track, so your fee earners don’t have to.',
    shot: CASEVIEW_SHOT,
  },
];

const day: Array<{ title: string } & Screen> = [
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

/**
 * A screenshot in the page's one frame. `fit` fixes the frame's shape so a row of them lines up whatever the shots'
 * own sizes (the top of each is kept; the rest is cropped). Without it the frame takes the shot's own shape.
 */
function Shot({ src, alt, width, height, phone = false, fit, dark = false }: { src: string; alt: string; width: number; height: number; phone?: boolean; fit?: 'wide' | 'tall' | 'fill'; dark?: boolean }) {
  // The screen eases out from a slight zoom as the device settles (Tilt sets --p).
  const img = 'block w-full';
  if (phone) {
    return (
      <Tilt className="mx-auto w-full max-w-[280px]">
        <div className="overflow-hidden rounded-[2.25rem] border-[7px] border-ink bg-white shadow-[0_40px_80px_-30px_rgba(21,16,31,0.55)]">
          <img src={src} alt={alt} width={width} height={height} className={`${img} h-auto`} style={SCREEN_ZOOM} />
        </div>
      </Tilt>
    );
  }
  // A tablet: a dark bezel round the screen, and a soft shadow under it.
  const bezel = `rounded-[1.6rem] p-2 md:p-2.5 ${dark ? 'bg-[#3A3348] ring-1 ring-white/25' : 'bg-ink'} shadow-[0_50px_90px_-40px_rgba(21,16,31,0.6)]`;
  const screen = 'overflow-hidden rounded-[1.05rem] bg-white';
  return (
    <Tilt>
      <div className={bezel}>
        {fit ? (
          <div className={`${screen} ${fit === 'wide' ? 'aspect-[16/10]' : fit === 'tall' ? 'aspect-[4/5]' : 'h-full'}`}>
            <img src={src} alt={alt} width={width} height={height} className={`${img} h-full object-cover object-left-top`} style={SCREEN_ZOOM} />
          </div>
        ) : (
          <div className={screen}>
            <img src={src} alt={alt} width={width} height={height} className={`${img} h-auto`} style={SCREEN_ZOOM} />
          </div>
        )}
      </div>
    </Tilt>
  );
}

/** Every section opens the same way: the heading, and at most one line under it, centred. */
function SectionHead({ title, lede, dark = false }: { title: string; lede?: string; dark?: boolean }) {
  return (
    <div className="mx-auto max-w-3xl text-center">
      <h2 className="font-serif text-4xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-5xl">{title}</h2>
      {lede && <p className={`mt-4 text-lg leading-relaxed md:text-xl ${dark ? 'text-paper/70' : 'text-ink-soft'}`}>{lede}</p>}
    </div>
  );
}

/** One action on this page: book a demo. */
function BookDemo({ where, onColour = false, size = 'lg', className = '' }: { where: string; onColour?: boolean; size?: 'lg' | 'xl'; className?: string }) {
  return <Cta label="Book A Demo" href={ctaHref(ROUTES.demo, PAGE_SOURCE, `${where}_demo`)} dataCta={`${where}_demo`} variant={onColour ? 'onColour' : 'primary'} size={size} className={className} />;
}

export default function Page() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.demo, PAGE_SOURCE, 'nav_demo')} signupLabel="Book A Demo" />

      {/* ── HERO ── the promise, the one action, and the doubt said out loud with the way down to its answer.
          The first screen: the promise and button centred in it, the scroll cue pinned to its foot. */}
      <section className="relative flex min-h-[calc(100svh-69px)] flex-col px-6">
        <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
          <h1 className="font-serif text-[2.35rem] font-bold leading-[1.04] tracking-tight sm:text-6xl lg:text-[4.25rem] xl:text-[4.5rem]">
            <span className="block whitespace-nowrap uppercase">Double the cases</span>
            <span className="block uppercase italic text-violet [text-wrap:balance] lg:whitespace-nowrap">without double the work</span>
          </h1>
          <div className="mt-12 flex w-full justify-center">
            <BookDemo where="hero" size="xl" className="w-2/3 sm:w-auto" />
          </div>
        </div>
        <div className="flex flex-col items-center gap-4 pb-10 text-center">
          <p className="font-serif text-xl font-bold uppercase tracking-tight md:text-2xl">Sound too good to be true?</p>
          <a href="#explain" className="group inline-flex flex-col items-center gap-2 text-base font-semibold text-violet underline decoration-violet/40 underline-offset-[6px] transition hover:decoration-violet md:text-lg" data-cta="hero_explain">
            Let us explain
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="motion-safe:animate-bounce"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
          </a>
        </div>
      </section>

      {/* ── WHY IT DOUBLES ── where Let Us Explain lands: the cap on a fee earner, the arithmetic of a firm's revenue, what a minute is worth. */}
      <section id="explain" className="scroll-mt-0 bg-ink px-6 py-24 text-paper md:py-32">
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-4xl text-center">
            <blockquote className="font-serif text-4xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-6xl">“I spend all day firefighting.”</blockquote>
            <p className="mt-10 text-xl leading-relaxed text-paper/80 [text-wrap:balance] md:text-2xl">A fee earner’s maximum caseload is capped by how many emails they can handle and how much case information they can keep in their head.</p>
            <p className="mt-4 font-serif text-2xl font-bold tracking-tight text-[#9B7BFF] md:text-3xl">Until now.</p>
          </div>
          {/* The arithmetic behind the promise: the firm's capacity is its fee earners' time over the time a case takes. */}
          <div className="mx-auto mt-20 max-w-5xl">
            <div className="flex flex-col items-center justify-center gap-5 font-serif text-3xl font-bold tracking-tight md:flex-row md:gap-7 md:text-4xl" role="math" aria-label="Fee earner hours per year, divided by hours per case, times average fee per case, equals your firm’s maximum revenue">
              <div className="flex flex-col items-center text-center">
                <span className="px-2 pb-3 [text-wrap:balance]">Fee earner hours per year</span>
                <span className="h-[3px] w-full rounded-full bg-paper/70" aria-hidden="true" />
                <span className="px-2 pt-3 [text-wrap:balance]">Hours per case</span>
              </div>
              <span className="text-[#9B7BFF]" aria-hidden="true">×</span>
              <span className="text-center [text-wrap:balance]">Average fee per case</span>
              <span className="text-[#9B7BFF]" aria-hidden="true">=</span>
              <span className="text-center text-[#9B7BFF] [text-wrap:balance]">Your firm’s maximum revenue</span>
            </div>
            <div className="mt-16 text-center">
              <p className="mx-auto max-w-xs text-xl leading-snug text-paper/80 [text-wrap:balance] md:max-w-none md:text-2xl">Every minute saved per case is worth</p>
              <p className="mt-3 font-serif text-6xl font-bold leading-none tracking-tight text-[#9B7BFF] md:text-8xl">
                <span className="group relative inline-block">
                  <span tabIndex={0} aria-describedby="minute-basis" className="inline-block cursor-help underline decoration-[#9B7BFF]/50 decoration-dotted decoration-4 underline-offset-[10px] outline-none focus-visible:decoration-solid md:-translate-x-[3px]">£1,314</span>
                  <span id="minute-basis" role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-4 w-72 -translate-x-1/2 rounded-xl bg-paper px-4 py-3 text-left font-sans text-sm font-medium leading-snug tracking-normal text-ink opacity-0 shadow-card transition group-hover:opacity-100 group-focus-within:opacity-100">
                    Based on 30 completions a month and £1,000 in average fees.
                    <span className="absolute left-1/2 top-full -ml-2 border-8 border-transparent border-t-paper" aria-hidden="true" />
                  </span>
                </span>
              </p>
              <p className="mt-4 text-xl leading-snug text-paper/80 md:text-2xl">per fee earner, per year.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── THE DEMO ── what a firm gets from 15 minutes: its own week, measured. */}
      <section className="bg-paper-soft px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <SectionHead title="See how much spare capacity you can win back on a demo" />
          <div className="mx-auto mt-16 max-w-5xl">
            <Shot {...MEASURE_SHOT} />
          </div>
          <div className="mt-12 flex justify-center">
            <BookDemo where="measure" size="xl" />
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── one step for each cap, then the terms and the ask. */}
      <section className="bg-ink px-6 py-24 text-paper md:py-32">
        <div className="mx-auto max-w-6xl">
          <SectionHead dark title="How it works" />
          <ol className="mt-20 grid gap-20 md:gap-24">
            {how.map((h, i) => (
              <li key={h.title} className="grid items-center gap-8 md:grid-cols-12 md:gap-12">
                <div className="md:col-span-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-violet font-serif text-lg font-bold text-white">{i + 1}</span>
                  <h3 className="mt-5 font-serif text-3xl font-bold tracking-tight md:text-4xl">{h.title}</h3>
                  <p className="mt-3 text-lg leading-relaxed text-paper/70">{h.line}</p>
                </div>
                <div className="md:col-span-8">
                  <Shot {...h.shot} dark />
                </div>
              </li>
            ))}
          </ol>
          <div className="mx-auto mt-24 max-w-3xl border-t border-white/10 pt-20 text-center md:mt-32">
            <p className="font-serif text-3xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-5xl">It’s free until we’ve doubled your capacity.</p>
            <p className="mt-4 text-lg leading-relaxed text-paper/70 md:text-xl">Let us prove it first. Then we’ll talk.</p>
            <p className="mt-12 font-serif text-lg font-bold uppercase tracking-tight md:text-xl">Sound good?</p>
            <div className="mt-5">
              <BookDemo where="guarantee" size="xl" />
            </div>
          </div>
        </div>
      </section>

      {/* ── UPDATES AT A GLANCE ── the board across the top; the case and the client's phone in one row of equal height. */}
      <section className="bg-violet px-6 py-24 text-white md:py-32">
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="font-serif text-4xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-5xl">Updates at a glance</h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg leading-relaxed text-white/80 [text-wrap:balance] md:text-xl">Nothing to hold in your head. Every case, where it is and who it’s waiting on, in one place.</p>
          </div>
          <div className="mt-16 grid gap-6 md:grid-cols-3">
            {day.map((d, i) => (
              <div key={d.title} className={i === 0 ? 'md:col-span-2' : 'relative min-h-[360px] overflow-hidden md:min-h-0'}>
                <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-white/70">{d.title}</p>
                {d.phone ? (
                  <>
                    {/* The phone is taller than the row: it shows from the top and fades out at the row's foot. */}
                    <div className="md:absolute md:inset-x-0 md:top-8">
                      <Shot src={d.src} alt={d.alt} width={d.width} height={d.height} phone />
                    </div>
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-violet to-transparent" />
                  </>
                ) : (
                  <Shot src={d.src} alt={d.alt} width={d.width} height={d.height} />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── THE VIDEO ── */}
      <section className="bg-paper-soft px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <SectionHead title="See it in 43 seconds" />
          <div className="mx-auto mt-16 max-w-4xl">
            <Vsl sources={[{ src: '/product/vsl-v15.mp4', type: 'video/mp4' }, { src: '/product/vsl-v15.webm', type: 'video/webm' }]} poster="/product/vsl-poster-6.webp" label="CONVEYi in 43 seconds" />
          </div>
        </div>
      </section>

      {/* ── SAFETY ── */}
      <section className="bg-ink px-6 py-24 text-paper md:py-32">
        <div className="mx-auto max-w-6xl">
          <SectionHead dark title="Built for the sector fraudsters target most" />
          <ul className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {safety.map((s) => (
              <li key={s.title} className="rounded-2xl bg-white/5 p-6 ring-1 ring-white/10">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-violet/30 text-[#C9B8FA]"><Icon name={s.icon} /></span>
                <p className="mt-5 text-lg font-bold leading-snug">{s.title}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── PRICING ── the guarantee first, then what it costs after. */}
      <section className="px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <SectionHead title="Pay nothing until your team handles double the cases" lede="Measured across the firm before you start. Never one person’s figures." />
          <div className="mt-16 grid gap-6 md:grid-cols-3">
            <div className="rounded-2xl border-2 border-violet bg-paper-soft p-8 shadow-violet">
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-violet">Until it has doubled</div>
              <div className="mt-4 font-serif text-5xl font-bold">£0</div>
              <p className="mt-3 text-ink-soft">Everything, every case.</p>
            </div>
            <div className="rounded-2xl border border-line bg-paper-soft p-8">
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-ink-soft">Then, per case</div>
              <div className="mt-4 font-serif text-5xl font-bold">£80<span className="font-sans text-lg font-normal text-ink-soft"> + VAT</span></div>
              <p className="mt-3 text-ink-soft">Once per case.</p>
            </div>
            <div className="rounded-2xl border border-line bg-paper-soft p-8">
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-ink-soft">Seats and monthly fee</div>
              <div className="mt-4 font-serif text-5xl font-bold">£0</div>
              <p className="mt-3 text-ink-soft">Everyone in the firm.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── QUESTIONS ── the objections, answered in the open. */}
      <section className="border-t border-line bg-paper-soft px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <SectionHead title="Questions" />
          <dl className="mx-auto mt-16 grid max-w-5xl gap-x-12 gap-y-10 md:grid-cols-2">
            {questions.map((x) => (
              <div key={x.q}>
                <dt className="text-xl font-bold">{x.q}</dt>
                <dd className="mt-2 text-lg leading-relaxed text-ink-soft">{x.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="bg-violet px-6 py-24 text-white md:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-serif text-4xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-5xl">Same team. Double the cases.</h2>
          <p className="mt-4 text-lg leading-relaxed text-white/80 md:text-xl">Find out how much time your team could save, in 15 minutes.</p>
          <div className="mt-10">
            <BookDemo where="footer" onColour size="xl" />
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
