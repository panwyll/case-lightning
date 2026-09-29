'use client';
import { ChevronRight } from '@/app/shared/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { CaseloadMap, House } from '@/app/shared/engine/CaseloadMap';
import { HEALTH_LABEL, LIFECYCLE_LABEL, type CaseToken, type CaseloadRollup } from '@/app/shared/engine/types';
import { paths } from '@/lib/paths';
import { ScopeSelect, type Scope } from '@/app/shared/engine/ScopeSelect';

/** Every open case as a list: find one by reference, address or handler, open it. */
const CSS = `
.cv-toggle{display:inline-flex;align-items:center;gap:7px;border:0;background:none;padding:4px 2px;font-size:12.5px;font-weight:600;color:#334155;cursor:pointer;font-family:inherit}
.cv-toggle i{width:28px;height:16px;border-radius:99px;background:#cbd5e1;position:relative;transition:background .12s}
.cv-toggle i::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:99px;background:#fff;transition:left .12s}
.cv-toggle.on i{background:#5A27E0}
.cv-toggle.on i::after{left:14px}
.cv-fold{display:flex;align-items:center;gap:6px;margin:16px 0 10px;border:0;background:none;padding:0;font:inherit;font-size:13px;font-weight:800;color:#0f172a;cursor:pointer}
.cv-fold .n{color:#94a3b8;font-weight:600;margin-left:4px}
.cv-search{width:100%;box-sizing:border-box;padding:10px 14px;border:1px solid #cbd5e1;border-radius:10px;font-size:14px;font-family:inherit;background:#fff;margin-bottom:12px}
.cv-list{background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:auto;max-height:60vh}
.cv-row{display:grid;grid-template-columns:28px 1fr 150px 150px 130px;gap:12px;align-items:center;padding:8px 14px;border-top:1px solid #f1f5f9;text-decoration:none;color:inherit}
.cv-row:first-child{border-top:0}
.cv-row:hover{background:#faf8ff}
.cv-addr{font-size:14px;font-weight:700;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-ref{font-size:12px;color:#94a3b8;margin-top:1px}
.cv-cell{font-size:12.5px;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv-health{font-size:12px;font-weight:700}
@media (max-width:820px){.cv-row{grid-template-columns:28px 1fr}.cv-cell,.cv-health{display:none}}
`;
const COLOUR: Record<string, string> = { normal: '#15803d', attention: '#1d4ed8', delayed: '#a16207', blocked: '#b91c1c', critical: '#111827' };
const RANK: Record<string, number> = { critical: 0, blocked: 1, delayed: 2, attention: 3, normal: 4 };

type Completions = { month: number; year: number; best: { month: string; n: number } | null; bestYear?: { year: string; n: number } | null };

export default function CaseViewPage() {
  const [rows, setRows] = useState<CaseToken[] | null>(null);
  const [rollup, setRollup] = useState<CaseloadRollup | null>(null);
  const [completions, setCompletions] = useState<Completions | null>(null);
  const [scope, setScope] = useState<Scope>('all');
  const [q, setQ] = useState('');
  const [listOpen, setListOpenState] = useState(true);
  useEffect(() => { try { if (localStorage.getItem('cv-list') === 'closed') setListOpenState(false); } catch { /* storage blocked */ } }, []);
  const setListOpen = (open: boolean) => { setListOpenState(open); try { localStorage.setItem('cv-list', open ? 'open' : 'closed'); } catch { /* storage blocked */ } };
  const [byHandler, setByHandler] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      let r = await api<{ rows: CaseToken[]; rollup: CaseloadRollup; completions?: Completions }>(`/engine/caseload?mine=${scope === 'mine' ? 1 : 0}`);
      // Every open case is tracked. One that is not gets enrolled now, then the board re-reads.
      if ((r.rollup.untracked ?? 0) > 0) {
        await api('/admin/enrol-all', { method: 'POST', body: '{}' }).catch(() => {});
        r = await api<{ rows: CaseToken[]; rollup: CaseloadRollup; completions?: Completions }>(`/engine/caseload?mine=${scope === 'mine' ? 1 : 0}`);
      }
      setRows(r.rows);
      setRollup(r.rollup);
      setCompletions(r.completions ?? null);
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
    <div className="eg">
      <style>{ENGINE_CSS + CSS}</style>
      {rows && rollup ? (
        <CaseloadMap
          title="Case View"
          actions={<ScopeSelect value={scope} onChange={setScope} />}
          corner={scope === 'all' ? <button type="button" className={`cv-toggle${byHandler ? ' on' : ''}`} role="switch" aria-checked={byHandler} onClick={() => setByHandler(!byHandler)}><i />Assignee</button> : undefined}
          rows={rows}
          rollup={rollup}
          completions={completions}
          byHandler={scope === 'all' && byHandler}
          onOpen={(id) => { window.location.href = paths.matter(id); }}
        />
      ) : (
        <div className="eg-top"><h1 className="eg-h1">Case View</h1><ScopeSelect value={scope} onChange={setScope} /></div>
      )}
      {/* The list folds away, leaving the board: a heads-up screen for the office TV. */}
      <button type="button" className="cv-fold" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}><ChevronRight size={16} style={{ transform: listOpen ? 'rotate(90deg)' : undefined, transition: 'transform .12s' }} />Case List<span className="n">{rows?.length ?? ''}</span></button>
      {listOpen && <input className="cv-search" placeholder="Reference, address or handler" value={q} onChange={(e) => setQ(e.target.value)} />}
      {err && <div className="eg-err">{err}</div>}
      {!rows && !err && <div className="eg-sub">Loading…</div>}
      {listOpen && list.length > 0 && <div className="cv-list">{list.map((r) => (
        <a key={r.matterId} className="cv-row" href={paths.matter(r.matterId)}>
          <House band={r.health?.band ?? 'normal'} size={24} />
          <span style={{ minWidth: 0 }}>
            <div className="cv-addr">{r.propertyAddress ?? r.matterRef ?? 'Case'}</div>
            <div className="cv-ref">{r.matterRef}{r.dayOfCase ? ` · day ${r.dayOfCase}` : ''}{r.sandbox ? <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: '#5A27E0', background: '#f3efff', borderRadius: 999, padding: '1px 6px' }}>SANDBOX</span> : null}</div>
          </span>
          <span className="cv-cell">{LIFECYCLE_LABEL[r.lifecycle] ?? r.lifecycle}</span>
          <span className="cv-cell">{r.assignedToName ?? 'Unassigned'}</span>
          <span className="cv-health" style={{ color: COLOUR[r.health?.band] ?? '#64748b' }}>{HEALTH_LABEL[r.health?.band] ?? ''}</span>
        </a>
      ))}</div>}
    </div>
  );
}
