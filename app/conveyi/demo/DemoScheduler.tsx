'use client';
import { useMemo, useState } from 'react';
import { ROUTES } from '../../_components/shared';

interface SlotDay { date: string; times: string[] }

const TZ = 'Europe/London';
const input = 'w-full rounded-xl border border-line bg-paper px-4 py-2.5 text-ink placeholder-ink-soft/50 transition focus:border-violet focus:outline-none focus:ring-1 focus:ring-violet';
const SIZES = ['1–2', '3–5', '6–10', '11–25', 'More than 25'];

const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...o }).format(new Date(iso));
const clock = (iso: string) => fmt(iso, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '');
const longDay = (iso: string) => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' });
/** A calendar date ("2026-10-26") as noon UTC, so formatting it never slips a day. */
const day = (date: string) => new Date(`${date}T12:00:00Z`);
const addDays = (date: string, n: number) => { const d = day(date); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Monday to Friday of every week the free days fall in, so each day sits under its own weekday. */
function weeks(days: SlotDay[]): string[][] {
  if (!days.length) return [];
  const dow = day(days[0].date).getUTCDay();
  let monday = addDays(days[0].date, -((dow + 6) % 7));
  const last = days[days.length - 1].date;
  const out: string[][] = [];
  while (monday <= last) { out.push([0, 1, 2, 3, 4].map((i) => addDays(monday, i))); monday = addDays(monday, 7); }
  return out;
}

const Svg = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const ClockIcon = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
const VideoIcon = () => <Svg><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></Svg>;
const PhoneIcon = () => <Svg><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></Svg>;
const GlobeIcon = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Svg>;
const BackIcon = () => <Svg><path d="m15 6-6 6 6 6" /></Svg>;
const TickIcon = () => <Svg><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></Svg>;

/** Pick a time, leave your details, get the invite: our own booking page (lib/server/demo/bookings.ts). */
export function DemoScheduler({ initial, phoneCall, host }: { initial: SlotDay[]; phoneCall: boolean; host: string }) {
  const [days, setDays] = useState(initial);
  const [date, setDate] = useState<string | null>(initial[0]?.date ?? null);
  const [start, setStart] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', email: '', firm: '', phone: '', feeEarners: '', note: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [booked, setBooked] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const grid = useMemo(() => weeks(days), [days]);
  const free = useMemo(() => new Map(days.map((d) => [d.date, d.times])), [days]);

  const refresh = async () => {
    const r = await fetch('/api/v1/demo/slots', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    if (r?.days) { setDays(r.days); setDate((d) => (d && r.days.some((x: SlotDay) => x.date === d) ? d : r.days[0]?.date ?? null)); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!start) return;
    setBusy(true); setErr(null);
    // Where they came from: the ad's tags on this page's address, if any.
    const params = new URLSearchParams(window.location.search);
    const source = Object.fromEntries([...params.entries()].filter(([k]) => /^(utm_|gclid|fbclid|li_fat_id)/.test(k)).map(([k, v]) => [k, v.slice(0, 200)]));
    try {
      const r = await fetch('/api/v1/demo/book', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...f, start, source }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) { setStart(null); await refresh(); throw new Error(j.error); }
      if (!r.ok) throw new Error(j?.error ?? 'It did not book. Please try again.');
      setBooked(start);
      const w = window as unknown as { gtag?: (...a: unknown[]) => void };
      w.gtag?.('event', 'demo_booked', { page_location: window.location.href });
    } catch (e: unknown) {
      setErr(e instanceof Error && e.message ? e.message : 'It did not book. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const meta = (
    <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-ink-soft">
      <span className="inline-flex items-center gap-1.5"><ClockIcon />15 Minutes</span>
      <span className="inline-flex items-center gap-1.5">{phoneCall ? <><PhoneIcon />Phone Call</> : <><VideoIcon />Video Call</>}</span>
      <span className="inline-flex items-center gap-1.5"><GlobeIcon />UK Time</span>
    </div>
  );

  if (booked) {
    return (
      <div className="rounded-3xl border border-line bg-paper-soft p-7 shadow-card md:p-8">
        <span className="text-violet"><TickIcon /></span>
        <h2 className="mt-3 font-serif text-3xl font-semibold tracking-tight">You’re Booked In</h2>
        <p className="mt-3 text-lg">{longDay(booked)}, {clock(booked)}</p>
        <p className="mt-2 text-ink-soft">The invite is on its way to {f.email}{phoneCall ? `. ${host.split(' ')[0]} will call you on ${f.phone}.` : '.'}</p>
        <a href={ROUTES.conveyi} className="mt-6 inline-block font-semibold text-violet underline underline-offset-4">Back To CONVEYi</a>
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-line bg-paper-soft p-6 shadow-card md:p-7">
      {start ? (
        <form onSubmit={(e) => void submit(e)} className="grid gap-3.5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-lg font-semibold">{longDay(start)}, {clock(start)}</p>
              <div className="mt-1.5">{meta}</div>
            </div>
            <button type="button" onClick={() => { setStart(null); setErr(null); }} className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-violet hover:underline"><BackIcon />Change</button>
          </div>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-semibold">Your Name<input id="demo-name" className={input} required minLength={2} value={f.name} onChange={set('name')} autoComplete="name" /></label>
            <label className="grid gap-1.5 text-sm font-semibold">Work Email<input id="demo-email" className={input} type="email" required value={f.email} onChange={set('email')} autoComplete="email" /></label>
            <label className="grid gap-1.5 text-sm font-semibold">Firm<input id="demo-firm" className={input} required minLength={2} value={f.firm} onChange={set('firm')} autoComplete="organization" /></label>
            <label className="grid gap-1.5 text-sm font-semibold">
              {phoneCall ? 'Phone' : <span>Phone <span className="font-normal text-ink-soft">(optional)</span></span>}
              <input id="demo-phone" className={input} type="tel" required={phoneCall} value={f.phone} onChange={set('phone')} autoComplete="tel" />
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-semibold"><span>Fee Earners <span className="font-normal text-ink-soft">(optional)</span></span>
            <select id="demo-size" className={`${input} h-[46px]`} value={f.feeEarners} onChange={set('feeEarners')}>
              <option value="" />
              {SIZES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-semibold"><span>Anything We Should Know <span className="font-normal text-ink-soft">(optional)</span></span><textarea id="demo-note" className={input} rows={2} value={f.note} onChange={set('note')} placeholder="Case management system, the kind of cases you run…" /></label>
          {/* A field people never see: a bot fills it in. */}
          <input id="demo-website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" value={f.website} onChange={set('website')} />
          {err && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</p>}
          <button type="submit" disabled={busy} className="mt-1 inline-flex items-center justify-center rounded-full bg-violet px-7 py-3.5 text-base font-semibold text-white shadow-violet transition hover:bg-violet-dark disabled:opacity-60" data-cta="demo_book">
            {busy ? 'Booking…' : 'Book Demo'}
          </button>
        </form>
      ) : (
        <div className="grid gap-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold">Pick A Time</h2>
            {meta}
          </div>
          {err && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</p>}
          {grid.length === 0 ? (
            <p className="text-ink-soft">No times are free in the next two weeks. Email <a className="font-semibold text-violet underline underline-offset-4" href={`mailto:pete@caselightning.co.uk?subject=CONVEYi%20demo`}>pete@caselightning.co.uk</a> and we will find one.</p>
          ) : (
            <>
              <div className="grid grid-cols-5 gap-2" role="group" aria-label="Day">
                {grid.flat().map((d) => {
                  const open = free.has(d);
                  const on = d === date;
                  return (
                    <button
                      key={d}
                      type="button"
                      disabled={!open}
                      onClick={() => { setDate(d); setErr(null); }}
                      aria-pressed={on}
                      className={`flex flex-col items-center rounded-xl border py-2 text-center transition ${on ? 'border-violet bg-violet text-white' : open ? 'border-line bg-paper hover:border-violet' : 'border-transparent text-ink-soft/40'}`}
                    >
                      <span className={`text-xs font-semibold uppercase tracking-wide ${on ? 'text-white/80' : open ? 'text-ink-soft' : ''}`}>{new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(day(d))}</span>
                      <span className="text-lg font-semibold leading-tight">{day(d).getUTCDate()}</span>
                      <span className={`text-xs ${on ? 'text-white/80' : open ? 'text-ink-soft' : ''}`}>{new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(day(d))}</span>
                    </button>
                  );
                })}
              </div>
              {date && free.has(date) && (
                <div>
                  <p className="mb-2.5 text-sm font-semibold text-ink-soft">{new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(day(date))}</p>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                    {free.get(date)!.map((t) => (
                      <button key={t} type="button" onClick={() => { setStart(t); setErr(null); }} className="rounded-xl border border-violet/40 bg-paper py-2.5 text-sm font-semibold text-violet transition hover:border-violet hover:bg-violet hover:text-white">
                        {clock(t)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
