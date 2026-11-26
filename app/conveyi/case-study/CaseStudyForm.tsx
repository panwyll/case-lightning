'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

const input = 'w-full rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-paper placeholder-paper/40 transition focus:border-[#9B7BFF] focus:outline-none focus:ring-1 focus:ring-[#9B7BFF]';

/** Name, email and phone (as Gym Launch's opt-in asked), then the video (lib/server/case-study.ts saves the lead and emails us). */
export function CaseStudyForm({ problem = null }: { problem?: string | null }) {
  const router = useRouter();
  const [f, setF] = useState({ name: '', email: '', phone: '', firm: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(problem);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const utm = Object.fromEntries([...new URLSearchParams(window.location.search)].filter(([k]) => k.startsWith('utm_')));
      const r = await fetch('/api/v1/case-study', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...f, source: utm }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? 'That didn’t go through. Try again.');
      const w = window as unknown as { gtag?: (...a: unknown[]) => void };
      w.gtag?.('event', 'generate_lead', { lead_source: 'case_study' });
      router.push('/conveyi/case-study/watch');
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t go through. Try again.');
      setBusy(false);
    }
  };
  return (
    <form id="form" method="post" action="/api/v1/case-study" onSubmit={submit} className="mx-auto grid max-w-md gap-3 text-left">
      <label className="grid gap-1.5 text-sm font-semibold text-paper/80">Your Name<input id="cs-name" name="name" className={input} required minLength={2} value={f.name} onChange={set('name')} autoComplete="name" /></label>
      <label className="grid gap-1.5 text-sm font-semibold text-paper/80">Work Email<input id="cs-email" name="email" className={input} type="email" required value={f.email} onChange={set('email')} autoComplete="email" /></label>
      <label className="grid gap-1.5 text-sm font-semibold text-paper/80">Phone<input id="cs-phone" name="phone" className={input} type="tel" required minLength={7} value={f.phone} onChange={set('phone')} autoComplete="tel" /></label>
      <label className="grid gap-1.5 text-sm font-semibold text-paper/80">Firm<input id="cs-firm" name="firm" className={input} value={f.firm} onChange={set('firm')} autoComplete="organization" /></label>
      <input id="cs-website" name="website" className="hidden" tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} aria-hidden="true" />
      {err && <p role="alert" className="rounded-xl bg-red-500/15 px-4 py-3 text-sm text-red-100">{err}</p>}
      <button type="submit" disabled={busy} data-cta="case_study_submit" className="mt-2 rounded-full bg-violet px-8 py-4 text-lg font-semibold text-white shadow-violet transition hover:brightness-110 disabled:opacity-60">{busy ? 'One Moment…' : 'Watch The Case Study'}</button>
      <p className="text-center text-sm text-paper/60">Free. We’ll email you the link too.</p>
    </form>
  );
}
