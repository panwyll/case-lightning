'use client';
import { useState } from 'react';
import { ROUTES } from '../../_components/shared';

const input = 'w-full rounded-xl border border-line bg-paper-soft px-4 py-3 text-ink placeholder-ink-soft/50 transition focus:border-violet focus:outline-none focus:ring-1 focus:ring-violet';
const SIZES = ['1–2', '3–5', '6–10', '11–25', 'More than 25'];

/** Ask for a demo when no booking calendar is set up: the request is saved and we are emailed (app/api/v1/demo-request). */
export function DemoForm() {
  const [f, setF] = useState({ name: '', email: '', firm: '', phone: '', feeEarners: '', note: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    // Where they came from: the ad's tags on this page's address, if any.
    const params = new URLSearchParams(window.location.search);
    const source = Object.fromEntries([...params.entries()].filter(([k]) => /^(utm_|gclid|fbclid|li_fat_id)/.test(k)).map(([k, v]) => [k, v.slice(0, 200)]));
    try {
      const r = await fetch('/api/v1/demo-request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...f, source }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message ?? j?.error ?? 'It did not send. Please try again, or email pete@caselightning.co.uk.');
      setDone(true);
      const w = window as unknown as { gtag?: (...a: unknown[]) => void };
      w.gtag?.('event', 'demo_request', { page_location: window.location.href });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'It did not send. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
          <div className="rounded-3xl border border-line bg-paper-soft p-7 shadow-card md:p-8">
            {done ? (
              <div>
                <h2 className="font-serif text-3xl font-semibold tracking-tight">Thank you.</h2>
                <p className="mt-3 text-ink-soft">We will email you within one working day to find a time.</p>
                <a href={ROUTES.conveyi} className="mt-6 inline-block font-semibold text-violet underline underline-offset-4">Back To CONVEYi</a>
              </div>
            ) : (
              <form onSubmit={(e) => void submit(e)} className="grid gap-4">
                <label className="grid gap-1.5 text-sm font-semibold">Your Name<input id="demo-name" className={input} required minLength={2} value={f.name} onChange={set('name')} autoComplete="name" /></label>
                <label className="grid gap-1.5 text-sm font-semibold">Work Email<input id="demo-email" className={input} type="email" required value={f.email} onChange={set('email')} autoComplete="email" /></label>
                <label className="grid gap-1.5 text-sm font-semibold">Firm<input id="demo-firm" className={input} required minLength={2} value={f.firm} onChange={set('firm')} autoComplete="organization" /></label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-1.5 text-sm font-semibold"><span>Phone <span className="font-normal text-ink-soft">(optional)</span></span><input id="demo-phone" className={`${input} h-12`} type="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" /></label>
                  <label className="grid gap-1.5 text-sm font-semibold"><span>Fee Earners <span className="font-normal text-ink-soft">(optional)</span></span>
                    <select id="demo-size" className={`${input} h-12`} value={f.feeEarners} onChange={set('feeEarners')}>
                      <option value="" />
                      {SIZES.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </label>
                </div>
                <label className="grid gap-1.5 text-sm font-semibold"><span>Anything We Should Know <span className="font-normal text-ink-soft">(optional)</span></span><textarea id="demo-note" className={input} rows={3} value={f.note} onChange={set('note')} placeholder="Case management system, when suits you…" /></label>
                {/* A field people never see: a bot fills it in. */}
                <input id="demo-website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" value={f.website} onChange={set('website')} />
                {err && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</p>}
                <button type="submit" disabled={busy} className="mt-1 inline-flex items-center justify-center rounded-full bg-violet px-7 py-3.5 text-base font-semibold text-white shadow-violet transition hover:bg-violet-dark disabled:opacity-60" data-cta="demo_submit">
                  {busy ? 'Sending…' : 'Request A Demo'}
                </button>
              </form>
            )}
          </div>
  );
}
