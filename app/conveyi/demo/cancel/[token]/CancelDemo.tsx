'use client';
import { useState } from 'react';
import { ROUTES } from '../../../../_components/shared';
import type { BookingView } from '@/lib/server/demo/bookings';

const when = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)).replace(' at ', ', ').replace(/\s(am|pm)/, '$1');

export function CancelDemo({ token, booking }: { token: string; booking: BookingView | null }) {
  const [b, setB] = useState(booking);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cancel = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/v1/demo/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? 'It did not cancel. Please try again.');
      setB(j);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'It did not cancel. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const again = <a href={ROUTES.demo} className="mt-6 inline-block font-semibold text-violet underline underline-offset-4">Book Another Time</a>;
  return (
    <div className="rounded-3xl border border-line bg-paper-soft p-7 shadow-card md:p-8">
      {!b ? (
        <><h1 className="font-serif text-3xl font-semibold tracking-tight">Link Not Recognised</h1>{again}</>
      ) : b.status === 'cancelled' ? (
        <><h1 className="font-serif text-3xl font-semibold tracking-tight">Demo Cancelled</h1><p className="mt-3 text-lg">{when(b.start)}</p>{again}</>
      ) : b.status === 'past' ? (
        <><h1 className="font-serif text-3xl font-semibold tracking-tight">This Demo Has Passed</h1><p className="mt-3 text-lg">{when(b.start)}</p>{again}</>
      ) : (
        <>
          <h1 className="font-serif text-3xl font-semibold tracking-tight">Cancel Your Demo?</h1>
          <p className="mt-3 text-lg">{when(b.start)}</p>
          <p className="mt-1 text-ink-soft">{b.name}, {b.firm}</p>
          {err && <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</p>}
          <div className="mt-6 flex flex-wrap items-center gap-5">
            <button type="button" onClick={() => void cancel()} disabled={busy} className="inline-flex items-center justify-center rounded-full bg-ink px-7 py-3 font-semibold text-white transition hover:bg-ink/85 disabled:opacity-60">{busy ? 'Cancelling…' : 'Cancel Demo'}</button>
            <a href={ROUTES.conveyi} className="font-semibold text-ink-soft hover:text-ink">Keep It</a>
          </div>
        </>
      )}
    </div>
  );
}
