'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { House } from '@/app/shared/engine/CaseloadMap';
import { HEALTH_LABEL, LIFECYCLE_LABEL, type CaseToken } from '@/app/shared/engine/types';
import { paths } from '@/lib/paths';

/** Every open case as a list: find one by reference, address or handler, open it. */
const CSS = `
.cv-search{width:100%;box-sizing:border-box;padding:10px 14px;border:1px solid #cbd5e1;border-radius:10px;font-size:14px;font-family:inherit;background:#fff;margin-bottom:12px}
.cv-row{display:grid;grid-template-columns:28px 1fr 150px 130px 130px;gap:12px;align-items:center;padding:11px 14px;background:#fff;border:1px solid #e6e8ee;border-radius:10px;margin-bottom:6px;text-decoration:none;color:inherit}
.cv-row:hover{border-color:#c4b5fd;background:#fcfbff}
.cv-addr{font-size:14px;font-weight:700;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-ref{font-size:12px;color:#94a3b8;margin-top:1px}
.cv-cell{font-size:12.5px;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv-health{font-size:12px;font-weight:700}
@media (max-width:820px){.cv-row{grid-template-columns:28px 1fr}.cv-cell,.cv-health{display:none}}
`;
const COLOUR: Record<string, string> = { normal: '#15803d', attention: '#b45309', delayed: '#c2410c', blocked: '#334155', critical: '#b91c1c' };
const RANK: Record<string, number> = { critical: 0, blocked: 1, delayed: 2, attention: 3, normal: 4 };

export default function CaseViewPage() {
  const [rows, setRows] = useState<CaseToken[] | null>(null);
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ rows: CaseToken[] }>(`/engine/caseload?mine=${scope === 'mine' ? 1 : 0}`);
      setRows(r.rows);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the cases.');
    }
  }, [scope]);
  useEffect(() => { void load(); }, [load]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows ?? [])
      .filter((r) => !needle || [r.matterRef, r.propertyAddress, r.assignedToName].some((v) => (v ?? '').toLowerCase().includes(needle)))
      .sort((a, b) => (RANK[a.health?.band] ?? 5) - (RANK[b.health?.band] ?? 5) || (a.propertyAddress ?? '').localeCompare(b.propertyAddress ?? ''));
  }, [rows, q]);

  return (
    <div className="eg" style={{ maxWidth: 1040, margin: '0 auto', padding: '16px 16px 60px' }}>
      <style>{ENGINE_CSS + CSS}</style>
      <div className="eg-top">
        <h1 className="eg-h1">Case View</h1>
        <button className={`eg-btn${scope === 'mine' ? ' on' : ''}`} onClick={() => setScope(scope === 'mine' ? 'all' : 'mine')}>{scope === 'mine' ? 'My matters' : 'Whole team'}</button>
      </div>
      <input className="cv-search" placeholder="Reference, address or handler" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {err && <div className="eg-err">{err}</div>}
      {!rows && !err && <div className="eg-sub">Loading…</div>}
      {rows && list.length === 0 && <div className="eg-empty">No matching cases.</div>}
      {list.map((r) => (
        <a key={r.matterId} className="cv-row" href={paths.matter(r.matterId)}>
          <House band={r.health?.band ?? 'normal'} size={24} />
          <span style={{ minWidth: 0 }}>
            <div className="cv-addr">{r.propertyAddress ?? r.matterRef ?? 'Matter'}</div>
            <div className="cv-ref">{r.matterRef}{r.dayOfCase ? ` · day ${r.dayOfCase}` : ''}</div>
          </span>
          <span className="cv-cell">{LIFECYCLE_LABEL[r.lifecycle] ?? r.lifecycle}</span>
          <span className="cv-cell">{r.assignedToName ?? 'Unassigned'}</span>
          <span className="cv-health" style={{ color: COLOUR[r.health?.band] ?? '#64748b' }}>{HEALTH_LABEL[r.health?.band] ?? ''}</span>
        </a>
      ))}
    </div>
  );
}
