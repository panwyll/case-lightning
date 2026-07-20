'use client';
import { useState } from 'react';
import { matterRefFrom, fallbackMatterRef } from '@/lib/ref-name';

async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('cl_token') : null;
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}

const TRACKS: Array<[string, string]> = [
  ['PURCHASE', 'Purchase (acting for buyer)'],
  ['SALE', 'Sale (acting for seller)'],
  ['REMORTGAGE', 'Remortgage'],
];
const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

export default function NewMatter({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [address, setAddress] = useState('');
  const [track, setTrack] = useState('PURCHASE');
  const [buyer, setBuyer] = useState('');
  const [seller, setSeller] = useState('');
  const [solicitor, setSolicitor] = useState('');
  const [agent, setAgent] = useState('');
  const [lender, setLender] = useState('');
  const [exchange, setExchange] = useState('');
  const [completion, setCompletion] = useState('');
  const [ref, setRef] = useState('');
  const [refTouched, setRefTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const derivedRef = matterRefFrom({ buyerNames: list(buyer), sellerNames: list(seller), propertyAddress: address });
  const shownRef = refTouched ? ref : derivedRef;

  const create = async () => {
    if (!address.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const matterRef = (shownRef.trim() || fallbackMatterRef());
      const created = await api<{ id: string }>('/matters', {
        method: 'POST',
        body: JSON.stringify({
          matterRef,
          propertyAddress: address.trim(),
          buyerNames: list(buyer),
          sellerNames: list(seller),
          counterpartySolicitor: solicitor.trim() || undefined,
          counterpartyAgent: agent.trim() || undefined,
          lender: lender.trim() || undefined,
          exchangeTargetDate: exchange || undefined,
          completionTargetDate: completion || undefined,
        }),
      });
      // track isn't accepted at creation — set it (and it drives "acting for") straight after.
      if (track !== 'PURCHASE') await api(`/matters/${created.id}`, { method: 'PATCH', body: JSON.stringify({ track }) }).catch(() => {});
      onCreated(created.id);
    } catch (e: any) {
      setErr(e?.message?.includes('graph') || e?.message?.toLowerCase?.().includes('token')
        ? 'Creating a matter provisions its OneDrive folder + Excel tracker, so you need Outlook connected first (open the CONVEYi add-in once to connect).'
        : (e?.message || 'Could not create the matter.'));
    } finally { setBusy(false); }
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.card} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <strong style={{ fontSize: 16, color: '#0f172a', flex: 1 }}>New matter</strong>
          <button onClick={onClose} style={S.x} aria-label="Close">✕</button>
        </div>
        <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 12px' }}>Provisions the OneDrive folder + Excel tracker automatically.</p>

        <label style={S.lbl}>Property address *</label>
        <input autoFocus value={address} onChange={(e) => setAddress(e.target.value)} placeholder="14 Oak Street, Leeds LS1 2AB" style={S.input} />

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}>
            <label style={S.lbl}>Acting for</label>
            <select value={track} onChange={(e) => setTrack(e.target.value)} style={S.input}>{TRACKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </div>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}>
            <label style={S.lbl}>Matter ref</label>
            <input value={shownRef} onChange={(e) => { setRef(e.target.value); setRefTouched(true); }} placeholder="auto" style={S.input} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}><label style={S.lbl}>Buyer(s)</label><input value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="comma-separated" style={S.input} /></div>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}><label style={S.lbl}>Seller(s)</label><input value={seller} onChange={(e) => setSeller(e.target.value)} placeholder="comma-separated" style={S.input} /></div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}><label style={S.lbl}>Other side (solicitor)</label><input value={solicitor} onChange={(e) => setSolicitor(e.target.value)} placeholder="e.g. Chloe Patel, Delaney & Webb" style={S.input} /></div>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}><label style={S.lbl}>Estate agent</label><input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="e.g. Hunters" style={S.input} /></div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}><label style={S.lbl}>Lender</label><input value={lender} onChange={(e) => setLender(e.target.value)} placeholder="e.g. Santander" style={S.input} /></div>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}><label style={S.lbl}>Exchange target</label><input type="date" value={exchange} onChange={(e) => setExchange(e.target.value)} style={S.input} /></div>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}><label style={S.lbl}>Completion target</label><input type="date" value={completion} onChange={(e) => setCompletion(e.target.value)} style={S.input} /></div>
        </div>

        {err && <div style={{ fontSize: 12, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 10px', margin: '10px 0 0' }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button onClick={create} disabled={!address.trim() || busy} style={{ ...S.btn, background: '#5A27E0', color: '#fff', border: 'none', opacity: !address.trim() || busy ? 0.5 : 1 }}>{busy ? 'Creating…' : 'Create matter'}</button>
          <button onClick={onClose} style={S.btn}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,15,30,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 12 },
  card: { background: '#fff', borderRadius: 14, padding: 16, width: '100%', maxWidth: 520, maxHeight: '92vh', overflowY: 'auto', boxSizing: 'border-box', boxShadow: '0 14px 44px rgba(0,0,0,0.3)' },
  x: { width: 26, height: 26, border: 'none', background: '#f1f5f9', borderRadius: 8, cursor: 'pointer', color: '#64748b', fontSize: 12 },
  lbl: { display: 'block', fontSize: 11, fontWeight: 700, color: '#64748b', margin: '10px 0 3px' },
  input: { width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '7px 9px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#0f172a' },
  btn: { fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#334155', cursor: 'pointer' },
};
