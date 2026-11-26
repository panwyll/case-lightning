import type { Metadata } from 'next';
import { ctaHref, Cta, NavHeader, ROUTES, SiteFooter } from '../../_components/shared';
import { Calculator } from './Calculator';
import { RagLegend } from './RagLegend';
import { LEAD_SCAN_WEEKS } from '@/lib/server/lead-scan';

export const metadata: Metadata = {
  title: 'Free Inbox Scan | CONVEYi',
  description: 'Connect Outlook and find out how much of your week doesn’t need a conveyancer, and what it’s costing you.',
};

/**
 * The free inbox scan: CONVEYi's lead magnet. Built the way $100M Leads describes one that reveals a problem: name
 * the result, one button, show what you get, take the risk away, deliver at once, then offer the next step (the demo,
 * on the results page). The scan itself: lib/server/lead-scan.ts.
 */
const START = '/api/v1/scan/start';
const SOURCE = 'scan';

const ERRORS: Record<string, string> = {
  admin: 'Your firm only lets IT approve apps. Ask them to approve CONVEYi in Microsoft 365, or book a demo and we’ll run the scan with you.',
  cancelled: 'Microsoft wasn’t given permission, so nothing was read.',
  expired: 'The sign-in timed out. Try again.',
  mailbox: 'This mailbox has been scanned three times today. Your results link is in your email.',
  busy: 'We’re at capacity today. Try again tomorrow, or book a demo and we’ll run it with you.',
  failed: 'The scan couldn’t start. Try again, or book a demo and we’ll run it with you.',
};

function ScanButton({ className = '' }: { className?: string }) {
  return <Cta label="Scan My Inbox Free" href={START} dataCta="scan_start" size="xl" className={className} />;
}

const Tick = () => (
  <svg viewBox="0 0 24 24" className="mt-0.5 h-5 w-5 shrink-0 text-[#9B7BFF]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg>
);

const gets: Array<{ title: string; line: string; img: { src: string; width: number; height: number; alt: string; wide?: { src: string; width: number; height: number } } }> = [
  {
    title: 'Your week',
    line: 'Your hours, coloured by what they’re spent on.',
    img: { src: '/product/app-measure-week.webp', width: 696, height: 754, alt: 'Example: a typical week, 56% red, 18% amber, 26% green.' },
  },
  {
    title: 'Where the hours go',
    line: 'Your biggest time drains, in hours a week and pounds a year.',
    img: { src: '/product/app-measure-issues-narrow.webp', width: 1008, height: 742, alt: 'Example: the key issues, from answering client status requests down, in hours a week and pounds a year.', wide: { src: '/product/app-measure-issues-card.webp', width: 1392, height: 754 } },
  },
];

const steps = [
  { title: 'Sign in with Microsoft', line: 'Use your work Outlook. It’s read-only.' },
  { title: `We read ${LEAD_SCAN_WEEKS} weeks of email`, line: 'What you sent and what you received, so we can see what each email was for.' },
  { title: 'See your results', line: 'On screen in about five minutes. We’ll email you the link too.' },
];

const safe: Array<{ q: string; a: string }> = [
  { q: 'Can it send or delete anything?', a: 'No. Microsoft only lets it read.' },
  { q: 'What do you keep?', a: 'What each email was for, when it was sent and whether it was with a client, an agent or a lender. We don’t keep the email itself or anyone’s address.' },
  { q: 'Does anyone read my emails?', a: 'No. Our software reads each one once and sends a short extract to our AI provider to label it. The extract isn’t kept.' },
  { q: 'How long do you have access?', a: 'An hour at most. Once the scan’s done, we can’t read anything.' },
];

export default async function ScanPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const problem = error ? ERRORS[error] ?? ERRORS.failed : null;
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.demo, SOURCE, 'nav_demo')} signupLabel="Book A Demo" />

      {/* ── HERO ── the result, free, the one button, and the risk taken away under it. */}
      <section id="start" className="bg-ink px-6 py-20 text-paper md:py-28">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="font-serif text-[2.35rem] font-bold uppercase leading-[1.04] tracking-tight [text-wrap:balance] sm:text-6xl lg:text-[4.25rem]">
            How much of your week doesn’t need you?
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-paper/75 [text-wrap:balance] md:text-xl">
            Connect Outlook and in five minutes you’ll know where your hours go and what they’re worth.
          </p>
          {problem && <p role="alert" className="mx-auto mt-8 max-w-2xl rounded-2xl bg-white/10 px-5 py-4 text-left text-base leading-relaxed text-paper ring-1 ring-white/15">{problem}</p>}
          <div className="mt-10"><ScanButton className="w-full sm:w-auto" /></div>
          <ul className="mx-auto mt-8 grid max-w-xl gap-2.5 text-left text-base text-paper/80 sm:grid-cols-2">
            <li className="flex gap-2.5"><Tick />Free</li>
            <li className="flex gap-2.5"><Tick />Read-only</li>
            <li className="flex gap-2.5"><Tick />We don’t keep your emails</li>
            <li className="flex gap-2.5"><Tick />Access ends after an hour</li>
          </ul>
        </div>
      </section>

      {/* ── WHAT YOU GET ── the charts themselves, labelled as examples. */}
      <section className="px-6 py-24 md:py-32">
        <div className="mx-auto max-w-6xl">
          <h2 className="mx-auto max-w-3xl text-center font-serif text-4xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-5xl">What you’ll see</h2>
          {/* The two cards as the app draws them, the same height side by side on a laptop (as on the landing page). */}
          <div className="mx-auto mt-16 grid max-w-md gap-12 md:max-w-none md:grid-cols-[1fr_2fr] md:gap-6">
            {gets.map((g) => (
              <div key={g.title} className="grid content-start gap-5">
                <figure className="relative">
                  <picture>
                    {g.img.wide && <source media="(min-width: 768px)" srcSet={g.img.wide.src} width={g.img.wide.width} height={g.img.wide.height} />}
                    <img src={g.img.src} width={g.img.width} height={g.img.height} alt={g.img.alt} className="block h-auto w-full [filter:drop-shadow(0_14px_24px_rgba(21,16,31,0.12))]" />
                  </picture>
                  <figcaption className="absolute -top-3 left-4 rounded-full bg-ink px-3 py-1 text-xs font-semibold text-paper">Example</figcaption>
                </figure>
                <div>
                  <h3 className="font-serif text-2xl font-bold tracking-tight md:text-3xl">{g.title}</h3>
                  <p className="mt-2 text-lg leading-relaxed text-ink-soft">{g.line}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-14 flex justify-center"><RagLegend /></div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── three steps, in order. */}
      <section className="bg-paper-soft px-6 py-24 md:py-32">
        <div className="mx-auto max-w-5xl">
          <h2 className="mx-auto max-w-3xl text-center font-serif text-4xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-5xl">How it works</h2>
          <ol className="mt-16 grid gap-10 md:grid-cols-3">
            {steps.map((s, i) => (
              <li key={s.title}>
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-violet font-serif text-lg font-bold text-white">{i + 1}</span>
                <h3 className="mt-5 font-serif text-2xl font-bold tracking-tight">{s.title}</h3>
                <p className="mt-2 text-lg leading-relaxed text-ink-soft">{s.line}</p>
              </li>
            ))}
          </ol>
          <div className="mt-16 text-center"><ScanButton /></div>
        </div>
      </section>

      {/* ── THE CALCULATOR ── usable without scanning; its figures value the scan's results. */}
      <section id="calculator" className="px-6 py-24 md:py-32">
        <div className="mx-auto max-w-5xl">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="font-serif text-4xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-5xl">What’s a minute worth to you?</h2>
            <p className="mt-4 text-lg leading-relaxed text-ink-soft md:text-xl">Put in your own numbers.</p>
          </div>
          <div className="mt-14"><Calculator /></div>
        </div>
      </section>

      {/* ── SAFE ── the objections to letting software read a mailbox, answered plainly. */}
      <section className="bg-ink px-6 py-24 text-paper md:py-32">
        <div className="mx-auto max-w-6xl">
          <h2 className="mx-auto max-w-3xl text-center font-serif text-4xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-5xl">Is it safe?</h2>
          <dl className="mx-auto mt-16 grid max-w-5xl gap-x-12 gap-y-10 md:grid-cols-2">
            {safe.map((x) => (
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
          <h2 className="font-serif text-4xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-5xl">How much of your week could you get back?</h2>
          <div className="mt-10">
            <Cta label="Scan My Inbox Free" href={START} dataCta="scan_start_footer" variant="onColour" size="xl" />
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
