'use client';
/**
 * The case's client portal, for the conveyancer: copy the link (it is also in every email to the
 * client), see whether they have used it, and reset it (the old link stops at once).
 */
import { useEffect, useState } from 'react';
import { Spin } from './BusyButton';
import { fmtDay, type Api } from './types';
import { Check } from '@/app/shared/icons';

const CSS = `.pc-btn{white-space:nowrap;display:inline-flex;align-items:center;gap:4px;border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:7px;padding:4px 10px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}.pc-btn:disabled{opacity:.55;cursor:default}
.pc-reset{border:0;background:none;padding:0;font:inherit;font-size:12px;font-weight:700;color:#5A27E0;cursor:pointer}.pc-reset:disabled{opacity:.55}`;

interface Portal { url: string; createdAt: string; firstOpenedAt: string | null; lastOpenedAt: string | null; opens: number; uploads: number }

export function PortalCard({ matterId, api }: { matterId: string; api: Api }) {
  const [p, setP] = useState<Portal | null | undefined>(undefined);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState<'copy' | 'reset' | null>(null);
  const [done, setDone] = useState<'copy' | 'reset' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<{ enabled: boolean; portal: Portal | null }>(`/matters/${matterId}/portal`).then((r) => { setEnabled(r.enabled !== false); setP(r.portal); }).catch(() => setP(null)); }, [api, matterId]);

  const go = async (action: 'link' | 'reset') => {
    const key = action === 'link' ? 'copy' : 'reset';
    setBusy(key); setErr(null);
    try {
      const r = await api<{ url: string; portal: Portal | null }>(`/matters/${matterId}/portal`, { method: 'POST', body: JSON.stringify({ action }) });
      setP(r.portal);
      if (action === 'link') await navigator.clipboard.writeText(r.url).catch(() => {});
      setDone(key);
      setTimeout(() => setDone(null), 1800);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  };

  if (!enabled) return null;
  const used = p?.lastOpenedAt ? `Opened ${p.opens} time${p.opens === 1 ? '' : 's'} · last ${fmtDay(p.lastOpenedAt)}${p.uploads ? ` · ${p.uploads} upload${p.uploads === 1 ? '' : 's'}` : ''}` : p ? 'Not opened yet' : null;
  return (
    <div style={{ marginTop: 12 }}>
      <style>{CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <b style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: '#64748b', marginRight: 'auto', whiteSpace: 'nowrap' }}>Client Portal</b>
        <button className="pc-btn" disabled={!!busy || p === undefined} onClick={() => void go('link')}>{busy === 'copy' ? <Spin>Copying…</Spin> : done === 'copy' ? <><Check size={16} /> Copied</> : 'Copy Link'}</button>
      </div>
      {used && (
        <div style={{ fontSize: 12, color: '#475569' }}>
          {used} · <button className="pc-reset" disabled={!!busy} onClick={() => void go('reset')}>{busy === 'reset' ? <Spin>Resetting…</Spin> : done === 'reset' ? 'Reset' : 'Reset Link'}</button>
        </div>
      )}
      {err && <div style={{ color: '#b91c1c', fontSize: 12, marginTop: 4 }}>{err}</div>}
    </div>
  );
}
