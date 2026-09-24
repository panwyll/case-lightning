'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { STAGE_LABEL, SUBFLOW_LABEL, SUB_FLOWS, ago, type QueueRow, type SubflowStatus } from '@/app/shared/engine/types';

/**
 * Addendum 3 §2 — the rollout board (admins). Each sub-flow's trust level, the
 * agreement rate its shadow conclusions have earned, and every matter still in shadow
 * mode with a link to its comparison. `autonomous` only ever changes the auto-clear
 * path: flagged items still surface to a person at every level.
 */
interface Board {
  subflows: Record<string, SubflowStatus>;
  perSubflow: Array<{ subFlow: string; status: SubflowStatus; reviewed: number; agreed: number; disagreed: number; agreementRate: number | null }>;
  shadowMatters: QueueRow[];
  liveMatters: number;
  totals: { reviewed: number; agreed: number };
}
const STATUS_HELP: Record<SubflowStatus, string> = {
  shadow: 'Logged only. Nothing surfaces, nothing is sent or ordered.',
  assist: 'Flagged items surface; auto-clears also surface as an advisory review.',
  autonomous: 'Flagged items surface; auto-clears proceed without a review.',
};

export default function RolloutPage() {
  const [b, setB] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setB(await api<Board>('/engine/shadow'));
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the rollout board (admins only).');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const set = async (subFlow: string, status: SubflowStatus) => {
    setBusy(subFlow);
    try {
      await api('/admin/engine/subflows', { method: 'PUT', body: JSON.stringify({ subFlow, status }) });
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not change the trust level.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="eg" style={{ maxWidth: 980, margin: '0 auto', padding: '24px 16px 40px' }}>
      <style>{ENGINE_CSS}</style>
      <div className="eg-top">
        <div>
          <h1 className="eg-h1">Rollout</h1>
          <p className="eg-sub">Promote each sub-flow from shadow to assist to autonomous on evidence: how often the engine's conclusion matched what the handler actually did.</p>
        </div>
        <a className="eg-btn" href="/conveyi/decisions">← Queue</a>
      </div>
      {err && <div className="eg-err">{err}</div>}
      {b && (
        <>
          <div className="eg-tiles">
            <div className="eg-tile"><b>{b.shadowMatters.length}</b><span>matters in shadow</span></div>
            <div className="eg-tile"><b>{b.liveMatters}</b><span>live matters</span></div>
            <div className="eg-tile"><b>{b.totals.reviewed}</b><span>conclusions reviewed</span></div>
            <div className="eg-tile"><b>{b.totals.reviewed ? `${Math.round((b.totals.agreed / b.totals.reviewed) * 100)}%` : '—'}</b><span>agreement overall</span></div>
          </div>
          <div className="eg-card" style={{ marginBottom: 18 }}>
            {SUB_FLOWS.map((sf) => {
              const p = b.perSubflow.find((x) => x.subFlow === sf)!;
              return (
                <div key={sf} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', gap: 12, alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid #f1f5f9' }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{SUBFLOW_LABEL[sf]}</div>
                    <div className="eg-sub">{STATUS_HELP[p.status]}</div>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 12.5, color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
                    <b style={{ color: '#0f172a', fontSize: 16 }}>{p.agreementRate === null ? '—' : `${Math.round(p.agreementRate * 100)}%`}</b>
                    <div>{p.reviewed} reviewed · {p.disagreed} disagreed</div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['shadow', 'assist', 'autonomous'] as SubflowStatus[]).map((st) => (
                      <button key={st} className={`eg-btn${p.status === st ? (st === 'shadow' ? ' on' : st === 'assist' ? ' accent' : ' primary') : ''}`} style={{ padding: '5px 9px', fontSize: 12 }} disabled={busy === sf} onClick={() => set(sf, st)} title={STATUS_HELP[st]}>{st}</button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: '#64748b', margin: '0 0 8px' }}>Matters in shadow mode</h2>
          {b.shadowMatters.length === 0 && <div className="eg-empty">No matter is in shadow mode. Enrol one with shadow mode on, or switch a matter into it from its comparison view.</div>}
          {b.shadowMatters.length > 0 && (
            <div className="eg-card">
              {b.shadowMatters.map((r) => (
                <a key={r.matterId} className="q-row" href={`/conveyi/engine/${r.matterId}/shadow`}>
                  <div style={{ minWidth: 0 }}>
                    <div className="q-addr">{r.propertyAddress ?? r.matterRef}</div>
                    <div className="q-ref">{r.matterRef}</div>
                  </div>
                  <span className="eg-chip stage">{STAGE_LABEL[r.stage] ?? r.stage}</span>
                  <div className="q-cell">{r.loggedCount} conclusion{r.loggedCount === 1 ? '' : 's'} logged · {ago(r.updatedAt)}</div>
                  <div className="q-cell hide"><span className="eg-chip shadow">shadow</span></div>
                </a>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
