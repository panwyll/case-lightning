import { REFERRALS_ENABLED } from '@/lib/flags';
import type { Metadata } from 'next';
import { ctaHref, ROUTES, Cta, NavHeader, SiteFooter } from '../_components/shared';
import { Vsl } from './Vsl';
import { MINUTE_PER_CASE_VALUE, VALUE_BASIS } from '@/lib/value';

export const metadata: Metadata = {
  title: 'CONVEYi — Double the cases without double the work | Case Lightning',
  description:
    'CONVEYi connects to Outlook, InTouch and LEAP and does everything on a conveyancing case that doesn’t need a lawyer: the updating, the chasing, the filing. Pay nothing until your team handles double the cases.',
};

const PAGE_SOURCE = 'landing';

// Captured from the running app with the local firm the dev seed creates (scripts/dev-seed.ts, dev-book.ts, dev-measure.ts).

interface Screen { src: string; width: number; height: number; alt: string; phone?: boolean }

const how: Array<{ title: string; line: string; shot: Screen; phone?: Screen }> = [
  {
    title: 'Save time',
    line: 'Emails filed to the right case. Chasers, client updates and searches drafted for one click, or sent on their own. Documents reviewed, with every point shown in the document.',
    shot: { src: '/product/app-automate.webp', width: 1806, height: 1470, alt: 'Tasks on one case: four searches to order and a chaser to the seller’s solicitor, each drafted with an Approve button, and below, what the case is waiting on and when each chase goes.' },
  },
  {
    title: 'Save headspace',
    line: 'Nothing to hold in your head. Every case, where it is and who it’s waiting on, in one place, and your clients see it too.',
    shot: { src: '/product/app-case-flow.webp', width: 2300, height: 1288, alt: 'A purchase at pre-completion: identity, source of funds, title, searches, mortgage and contract and exchange done, signing and completion in progress, beside the property, buyer, price, lender, target dates and handler.' },
    phone: { src: '/product/app-portal.webp', width: 1170, height: 2500, phone: true, alt: 'A client’s portal on a phone, in a made-up firm’s logo and colour: the parts of their purchase side by side, done, with the client, or in progress, and the enquiries with the seller’s solicitor, usually two weeks a round, expected by a date.' },
  },
];

const questions: Array<{ q: string; a: string }> = [
  { q: 'Will it send something wrong?', a: 'Nothing goes on its own until you switch that kind of message on. Exchange, completion and money always need a person.' },
  { q: 'Do we have to change systems?', a: 'No. It works on the Outlook, InTouch and LEAP you already use. Nothing to migrate.' },
  { q: 'Where does our data go?', a: 'Your emails and documents stay in your own Microsoft 365.' },
  { q: 'What if we don’t double our capacity?', a: 'Then you don’t pay. We measure your firm’s capacity before you start, and it’s free until that has doubled.' },
];

/**
 * A screenshot in the page's one frame. `fit` fixes the frame's shape so a row of them lines up whatever the shots'
 * own sizes (the top of each is kept; the rest is cropped). Without it the frame takes the shot's own shape.
 */
function Shot({ src, alt, width, height, phone = false, fit }: { src: string; alt: string; width: number; height: number; phone?: boolean; fit?: 'wide' | 'tall' | 'fill'; dark?: boolean; face?: 'left' | 'right' }) {
  if (phone) {
    return (
      <div className="mx-auto w-full max-w-[280px] overflow-hidden rounded-[2.1rem] border-[6px] border-ink bg-white shadow-card">
        <img src={src} alt={alt} width={width} height={height} className="block h-auto w-full" />
      </div>
    );
  }
  return (
    <div className={`overflow-hidden rounded-xl border border-ink/15 bg-white shadow-card ${fit === 'wide' ? 'aspect-[16/10]' : fit === 'tall' ? 'aspect-[4/5]' : fit === 'fill' ? 'h-full' : ''}`}>
      <img src={src} alt={alt} width={width} height={height} className={`block w-full ${fit ? 'h-full object-cover object-left-top' : 'h-auto'}`} />
    </div>
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
function BookDemo({ where, onColour = false, size = 'lg', className = '', label = 'Book A Demo' }: { where: string; onColour?: boolean; size?: 'lg' | 'xl'; className?: string; label?: string }) {
  return <Cta label={label} href={ctaHref(ROUTES.demo, PAGE_SOURCE, `${where}_demo`)} dataCta={`${where}_demo`} variant={onColour ? 'onColour' : 'primary'} size={size} className={className} />;
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
                  <span tabIndex={0} aria-describedby="minute-basis" className="inline-block cursor-help underline decoration-[#9B7BFF]/50 decoration-dotted decoration-4 underline-offset-[10px] outline-none focus-visible:decoration-solid md:-translate-x-[3px]">£{MINUTE_PER_CASE_VALUE.toLocaleString('en-GB')}</span>
                  <span id="minute-basis" role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-4 w-72 -translate-x-1/2 rounded-xl bg-paper px-4 py-3 text-left font-sans text-sm font-medium leading-snug tracking-normal text-ink opacity-0 shadow-card transition group-hover:opacity-100 group-focus-within:opacity-100">
                    Based on {VALUE_BASIS.completionsPerMonth} completions a month and £{VALUE_BASIS.averageFee.toLocaleString('en-GB')} in average fees.
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
          {/* The two cards from the measurement, as they are in the app: side by side on a laptop, one above the other on a phone, where Key Issues shows its top six so the labels stay readable. Per conveyancer, valued on lib/value.ts. */}
          <div className="mx-auto mt-16 grid max-w-md items-start gap-5 md:max-w-5xl md:grid-cols-[1fr_2fr] md:gap-6">
            <img src="/product/app-measure-week.webp" width={696} height={754} alt="A typical week per conveyancer: 56% red, 18% amber, 26% green; the red and amber worth £311k a year." className="block h-auto w-full [filter:drop-shadow(0_14px_24px_rgba(21,16,31,0.12))]" />
            <picture>
              <source media="(min-width: 768px)" srcSet="/product/app-measure-issues-card.webp" width={1392} height={754} />
              <img src="/product/app-measure-issues-narrow.webp" width={1008} height={742} alt="Key Issues: the hours a week each kind of work takes a conveyancer, and what each is worth a year, from answering client status requests (5.2 hours, £50k) down." className="block h-auto w-full [filter:drop-shadow(0_14px_24px_rgba(21,16,31,0.12))]" />
            </picture>
          </div>
          <div className="mt-12 flex justify-center">
            <BookDemo where="measure" size="xl" label="Book A 15 Min Demo" />
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── one step for each cap (time, and what a fee earner has to keep in their head), then the terms and the ask. */}
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
                  {h.phone ? (
                    // The case, with the client's phone over its corner showing the top of their portal.
                    <div className="relative pb-6">
                      <div className="w-[84%]"><Shot {...h.shot} /></div>
                      <div className="absolute bottom-0 right-0 w-[28%] overflow-hidden rounded-[1.4rem] border-[5px] border-[#2E2740] bg-white shadow-card ring-1 ring-white/25 md:rounded-[1.9rem] md:border-[6px]">
                        <img src={h.phone.src} alt={h.phone.alt} width={h.phone.width} height={h.phone.height} className="block aspect-[9/16] w-full object-cover object-top" />
                      </div>
                    </div>
                  ) : <Shot {...h.shot} />}
                </div>
              </li>
            ))}
          </ol>
          <div id="pricing" className="mx-auto mt-24 max-w-3xl scroll-mt-24 border-t border-white/10 pt-20 text-center md:mt-32">
            <p className="font-serif text-3xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-5xl">It’s free until we’ve doubled your capacity.</p>
            <p className="mt-4 text-lg leading-relaxed text-paper/70 [text-wrap:balance] md:text-xl">Then £80 per case –{' '}<br className="sm:hidden" />only pay for what you use.</p>
            <p className="mt-12 font-serif text-lg font-bold uppercase tracking-tight md:text-xl">Sound good?</p>
            <div className="mt-5">
              <BookDemo where="guarantee" size="xl" />
            </div>
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

      {/* ── QUESTIONS ── the objections, answered in the open. */}
      <section className="bg-ink px-6 py-24 text-paper md:py-32">
        <div className="mx-auto max-w-6xl">
          <SectionHead dark title="Questions" />
          <dl className="mx-auto mt-16 grid max-w-5xl gap-x-12 gap-y-10 md:grid-cols-2">
            {questions.map((x) => (
              <div key={x.q}>
                <dt className="text-xl font-bold">{x.q}</dt>
                <dd className="mt-2 text-lg leading-relaxed text-paper/70">{x.a}</dd>
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
