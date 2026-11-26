'use client';
import { useEffect, useRef, useState } from 'react';
import { ParetoCard, RagCard, TIME_CSS } from '@/app/shared/epa/TimeView';
import { pounds, weeklyHourValueOf } from '@/lib/value';
import type { LeadScanView } from '@/lib/server/lead-scan';
import { Calculator, useCalcInputs } from '../Calculator';
import { RagLegend } from '../RagLegend';

const START = '/api/v1/scan/start';
const running = (v: LeadScanView | null) => !!v && (v.status === 'SCANNING_SENT' || v.status === 'SCANNING_INBOX');
const n = (x: number) => x.toLocaleString('en-GB');
const pct = (x: number) => `${Math.round(x * 100)}%`;

function Step({ on, done, title, line }: { on: boolean; done: boolean; title: string; line: string }) {
  return (
    <li className={`flex items-start gap-4 rounded-2xl border px-5 py-4 ${on ? 'border-violet bg-violet-soft' : 'border-line bg-paper-soft'}`}>
      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${done ? 'bg-[#1E8E4E] text-white' : on ? 'bg-violet text-white' : 'bg-line text-ink-soft'}`} aria-hidden="true">
        {done ? <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4.5 4.5L19 7" /></svg>
          : on ? <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-white" /> : null}
      </span>
      <span><b className="block text-lg">{title}</b><span className="text-ink-soft">{line}</span></span>
    </li>
  );
}

/** Drives a free scan from this page (a slice at a time), then shows the week, valued at the firm's own figures. */
export function ScanResult({ token, initial, demoHref }: { token: string; initial: LeadScanView | null; demoHref: string }) {
  const [v, setV] = useState<LeadScanView | null>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [inputs, setInputs] = useCalcInputs();
  const busy = useRef(false);

  useEffect(() => {
    if (!running(v) || busy.current) return;
    busy.current = true;
    (async () => {
      for (;;) {
        const r = await fetch(`/api/v1/scan/${token}`, { method: 'POST' }).catch(() => null);
        const j = r ? await r.json().catch(() => null) : null;
        if (!r || !r.ok || !j || j.error) { setErr(j?.error ?? 'The scan stopped. Start it again.'); break; }
        setV(j);
        if (!running(j)) break;
      }
      busy.current = false;
    })();
  }, [token, v?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!v) {
    return (
      <section className="px-6 py-24 text-center">
        <h1 className="font-serif text-4xl font-bold tracking-tight">This link has expired</h1>
        <p className="mt-4 text-lg text-ink-soft">Start a new scan to see your results.</p>
        <a href={START} className="mt-8 inline-flex rounded-full bg-violet px-8 py-4 text-lg font-semibold text-white shadow-violet">Scan My Inbox Free</a>
      </section>
    );
  }

  const first = v.name?.split(/\s+/)[0];
  const failed = v.status === 'FAILED' || !!err;
  if (failed || running(v)) {
    const sentDone = v.status !== 'SCANNING_SENT';
    return (
      <section className="px-6 py-20 md:py-28">
        <div className="mx-auto max-w-2xl">
          <h1 className="font-serif text-4xl font-bold tracking-tight [text-wrap:balance] md:text-5xl">{failed ? 'The scan stopped' : `Reading your inbox${first ? `, ${first}` : ''}`}</h1>
          <p className="mt-4 text-lg text-ink-soft">{failed ? (err ?? v.error ?? 'Start it again.') : 'Keep this page open. It takes about five minutes, and we’ll email you the link when it’s done.'}</p>
          {failed ? (
            <a href={START} className="mt-8 inline-flex rounded-full bg-violet px-8 py-4 text-lg font-semibold text-white shadow-violet">Start Again</a>
          ) : (
            <ol className="mt-10 grid gap-3" aria-live="polite">
              <Step on={!sentDone} done={sentDone} title="Sent Items" line={`${n(v.read.sent)} emails read`} />
              <Step on={sentDone} done={false} title="Inbox" line={sentDone ? `${n(v.read.received)} emails read, ${n(v.read.setAside)} newsletters and automated emails skipped` : 'Next'} />
              <Step on={false} done={false} title="Your week" line="Last" />
            </ol>
          )}
        </div>
      </section>
    );
  }

  const m = v.measurement;
  const perHour = weeklyHourValueOf(inputs);
  const worth = (h: number) => pounds(h * perHour);
  return (
    <>
      <style>{TIME_CSS}</style>
      <section className="bg-ink px-6 py-16 text-paper md:py-20">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="font-serif text-4xl font-bold tracking-tight [text-wrap:balance] md:text-6xl">{first ? `${first}, here’s your week` : 'Here’s your week'}</h1>
          {m ? (
            <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-paper/75 [text-wrap:balance] md:text-xl">
              {pct(m.share.red + m.share.amber)} of it is red or amber. That’s about {Math.round(m.hours.red + m.hours.amber)} hours a week, worth {worth(m.hours.red + m.hours.amber)} a year on your numbers.
            </p>
          ) : (
            <p className="mx-auto mt-5 max-w-2xl text-lg text-paper/75">There wasn’t enough email in the last four weeks to show your week.</p>
          )}
        </div>
      </section>

      {m && (
        <section className="bg-paper-soft px-6 py-16 md:py-20">
          <div className="mx-auto grid max-w-6xl items-start gap-5 md:grid-cols-[1fr_2fr]">
            <RagCard title="A Typical Week" right="You" hours={m.hours} share={m.share} unseen={{ hours: m.hours.unseen, share: m.share.unseen }}
              foot={<>Red And Amber<b style={{ display: 'block', color: '#0f172a', fontSize: 18, fontWeight: 800, margin: '2px 0 10px' }}>{worth(m.hours.red + m.hours.amber)}/Year</b>{m.contractedHours}h Week</>} />
            <ParetoCard lines={m.lines} right="Hours A Week · £/Year" value={worth} />
          </div>
          <div className="mt-10 flex justify-center"><RagLegend /></div>
          {v.thin && <p className="mx-auto mt-6 max-w-6xl text-ink-soft">We only found {n(v.read.sent)} sent emails in four weeks, so treat these as rough.</p>}
          <p className="mx-auto mt-6 max-w-6xl text-sm text-ink-soft">We read {n(v.read.sent)} sent and {n(v.read.received)} received emails from {new Date(v.since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} to {new Date(v.until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.</p>
        </section>
      )}

      <section className="bg-violet px-6 py-20 text-white md:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-serif text-4xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-5xl">Want that time back?</h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg leading-relaxed text-white/80 md:text-xl">CONVEYi takes the red and amber off your fee earners. It’s free until we’ve doubled your capacity.</p>
          <a href={demoHref} data-cta="scan_result_demo" className="mt-10 inline-flex rounded-full bg-white px-8 py-4 text-lg font-semibold text-violet shadow-card">Book A 15 Min Demo</a>
        </div>
      </section>

      <section className="px-6 py-20 md:py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="font-serif text-4xl font-bold leading-[1.1] tracking-tight [text-wrap:balance] md:text-5xl">Change the numbers</h2>
            <p className="mt-4 text-lg leading-relaxed text-ink-soft md:text-xl">Your results are worked out with these.</p>
          </div>
          <div className="mt-14"><Calculator value={inputs} onChange={setInputs} /></div>
        </div>
      </section>
    </>
  );
}
