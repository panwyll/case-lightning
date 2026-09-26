'use client';
import { paths } from '@/lib/paths';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { ENGINE_ACTION_LABEL, TRUST_LEVELS, type TrustLevel } from '@/app/shared/engine/types';

interface Row { action: string; level: TrustLevel; proposed: number; approved: number; rejected: number; pending: number }
interface Board { levels: Record<string, TrustLevel>; actions: Row[] }

const LEVEL_LABEL: Record<TrustLevel, string> = { propose: 'Propose', assist: 'Assist', auto: 'Auto' };

export default function TrustLevelsPage() {
  const [b, setB] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setB(await api<Board>('/engine/shadow'));
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load trust levels (admins only).');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const set = async (action: string, level: TrustLevel) => {
    setBusy(action);
    try {
      await api('/admin/engine/subflows', { method: 'PUT', body: JSON.stringify({ action, level }) });
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not change the trust level.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="eg" style={{ maxWidth: 900 }}>
      <style>{ENGINE_CSS}</style>
      <div className="eg-top">
        <h1 className="eg-h1">Trust levels</h1>
        <a className="eg-btn" href={paths.integrations}>← Tools</a>
      </div>
      {err && <div className="eg-err">{err}</div>}
      {b && (
        <div className="eg-card">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 90px 90px 90px auto', gap: 12, padding: '8px 14px', fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: '#94a3b8' }}>
            <span>Action</span><span style={{ textAlign: 'right' }}>Approved</span><span style={{ textAlign: 'right' }}>Rejected</span><span style={{ textAlign: 'right' }}>Waiting</span><span>Level</span>
          </div>
          {b.actions.map((r) => (
            <div key={r.action} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 90px 90px 90px auto', gap: 12, alignItems: 'center', padding: '12px 14px', borderTop: '1px solid #f1f5f9', fontVariantNumeric: 'tabular-nums' }}>
              <div style={{ fontWeight: 700 }}>{ENGINE_ACTION_LABEL[r.action] ?? r.action}</div>
              <div style={{ textAlign: 'right' }}>{r.approved}</div>
              <div style={{ textAlign: 'right', color: r.rejected ? '#b91c1c' : undefined }}>{r.rejected}</div>
              <div style={{ textAlign: 'right', color: '#64748b' }}>{r.pending}</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {TRUST_LEVELS.map((lv) => (
                  <button key={lv} className={`eg-btn${r.level === lv ? (lv === 'propose' ? ' on' : lv === 'assist' ? ' accent' : ' primary') : ''}`} style={{ padding: '5px 9px', fontSize: 12 }} disabled={busy === r.action || r.level === lv} onClick={() => void set(r.action, lv)}>{LEVEL_LABEL[lv]}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
