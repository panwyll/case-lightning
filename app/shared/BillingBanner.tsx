'use client';
/**
 * The firm's billing state, where everyone sees it: a failed payment (full service until the
 * grace period ends) or a suspension (cases can be read; nothing is sent until they pay).
 * The button goes straight to paying: the card on file (Stripe's portal) or a new subscription.
 */
import { useState } from 'react';
import { AlertTriangle } from '@/app/shared/icons';
import { api } from '@/app/shared/engine/api';

export function BillingBanner({ state, until, subscribed }: { state: 'grace' | 'suspended'; until: string | null; subscribed: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pay = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ url?: string }>(subscribed ? '/billing/portal' : '/billing/checkout', { method: 'POST' });
      if (r.url) window.location.href = r.url;
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not open payment.'); }
    finally { setBusy(false); }
  };
  const day = until ? new Date(until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null;
  const grace = state === 'grace';
  return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 14px', margin: '0 0 12px', borderRadius: 10, border: `1px solid ${grace ? '#fcd34d' : '#fca5a5'}`, background: grace ? '#fffbeb' : '#fef2f2', color: grace ? '#78350f' : '#7f1d1d', fontSize: 13 }}>
      <AlertTriangle size={16} />
      <b style={{ fontWeight: 700 }}>{grace ? `Payment failed. Service continues until ${day ?? 'the grace period ends'}.` : 'Account paused: payment overdue. Cases are read-only and nothing is sent until you pay.'}</b>
      <button type="button" disabled={busy} onClick={() => void pay()} style={{ marginLeft: 'auto', border: 0, borderRadius: 8, padding: '6px 14px', fontWeight: 700, fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer', background: grace ? '#b45309' : '#b91c1c', color: '#fff' }}>{busy ? 'Opening…' : subscribed ? 'Update Payment' : 'Subscribe'}</button>
      {err && <span style={{ width: '100%', fontSize: 12 }}>{err}</span>}
    </div>
  );
}
