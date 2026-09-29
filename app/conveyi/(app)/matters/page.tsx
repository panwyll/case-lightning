'use client';
import { ChevronRight, Filter } from '@/app/shared/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { CaseloadMap, House } from '@/app/shared/engine/CaseloadMap';
import { HEALTH_LABEL, LIFECYCLE_LABEL, TRANSACTION_LABEL, type CaseToken, type CaseloadRollup } from '@/app/shared/engine/types';
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
.cv-bar{display:flex;gap:8px;margin-bottom:12px}
.cv-search{flex:1;min-width:0;box-sizing:border-box;padding:10px 14px;border:1px solid #cbd5e1;border-radius:10px;font-size:14px;font-family:inherit;background:#fff}
.cv-fbtn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:42px;flex:none;border:1px solid #cbd5e1;border-radius:10px;background:#fff;color:#475569;cursor:pointer}
.cv-fbtn.on{border-color:#5A27E0;color:#5A27E0;background:#f6f3ff}
.cv-fbtn b{position:absolute;top:-6px;right:-6px;min-width:17px;height:17px;border-radius:99px;background:#5A27E0;color:#fff;font-size:10.5px;font-weight:800;display:flex;align-items:center;justify-content:center;padding:0 4px;box-sizing:border-box}
.cv-filters{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px 12px;align-items:end;background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:12px 14px;margin-bottom:12px}
.cv-filters label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:700;color:#64748b}
.cv-filters .eg-sel{width:100%}
.cv-clear{justify-self:start;border:0;background:none;padding:8px 0;font:inherit;font-size:12.5px;font-weight:700;color:#5A27E0;cursor:pointer}
.cv-none{padding:14px;font-size:13px;color:#64748b;background:#fff;border:1px solid #e6e8ee;border-radius:12px}
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

type Status = 'open' | 'completed' | 'abandoned' | 'closed' | 'all';
type Filters = { assignee: string; status: Status; health: string; stage: string; type: string; within: string };
const NO_FILTERS: Filters = { assignee: '', status: 'open', health: '', stage: '', type: '', within: '' };
const WITHIN: Record<string, string> = { '30': 'Last 30 Days', '90': 'Last 3 Months', '365': 'Last Year' };

/** What a case's status is for the filters: abandoned, closed, completed (money moved), otherwise open. */
const statusOf = (r: CaseToken): Exclude<Status, 'all'> =>
  r.lifecycle === 'aborted' ? 'abandoned' : r.lifecycle === 'closed' && !r.completedAt ? 'closed' : r.completedAt || r.lifecycle === 'completed' || r.lifecycle === 'post_completion' || r.lifecycle === 'closed' ? 'completed' : 'open';
/** The date the "When" filter reads: when it ended for a finished case, when it completed, else when it was opened. */
const whenOf = (r: CaseToken, status: Status) => (status === 'completed' ? r.completedAt : status === 'abandoned' || status === 'closed' ? r.endedAt : r.endedAt ?? r.openedAt) ?? null;

type Completions = { month: number; year: number; best: { month: string; n: number } | null; bestYear?: { year: string; n: number } | null };

export default function CaseViewPage() {
  const [rows, setRows] = useState<CaseToken[] | null>(null);
  const [rollup, setRollup] = useState<CaseloadRollup | null>(null);
  const [completions, setCompletions] = useState<Completions | null>(null);
  const [scope, setScope] = useState<Scope>('all');
  const [q, setQ] = useState('');
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [finished, setFinished] = useState<CaseToken[] | null>(null);
  const active = (Object.keys(NO_FILTERS) as Array<keyof Filters>).filter((k) => f[k] !== NO_FILTERS[k]).length;
  const wantFinished = f.status !== 'open';
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
  // Finished cases are fetched only when a filter asks for them: the board is live work.
  useEffect(() => { setFinished(null); }, [scope]);
  useEffect(() => {
    if (!wantFinished || finished) return;
    api<{ finished?: CaseToken[] }>(`/engine/caseload?finished=1&mine=${scope === 'mine' ? 1 : 0}`).then((r) => setFinished(r.finished ?? [])).catch(() => setFinished([]));
  }, [wantFinished, finished, scope]);

  const pool = useMemo(() => (wantFinished ? [...(rows ?? []), ...(finished ?? [])] : rows ?? []), [rows, finished, wantFinished]);
  const handlers = useMemo(() => Array.from(new Map(pool.filter((r) => r.assignedTo).map((r) => [r.assignedTo as string, r.assignedToName ?? 'Someone'])).entries()).sort((a, b) => a[1].localeCompare(b[1])), [pool]);
  const stages = useMemo(() => Array.from(new Set(pool.map((r) => r.lifecycle))).sort((a, b) => (LIFECYCLE_LABEL[a] ?? a).localeCompare(LIFECYCLE_LABEL[b] ?? b)), [pool]);
  const types = useMemo(() => Array.from(new Set(pool.map((r) => r.transactionType).filter((t): t is NonNullable<typeof t> => !!t))), [pool]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const since = f.within ? Date.now() - Number(f.within) * 86_400_000 : null;
    return pool
      .filter((r) => !needle || [r.matterRef, r.propertyAddress, r.assignedToName].some((v) => (v ?? '').toLowerCase().includes(needle)))
      .filter((r) => {
        const st = statusOf(r);
        if (f.status === 'open' ? (rows ?? []).every((x) => x.matterId !== r.matterId) : f.status !== 'all' && st !== f.status) return false;
        if (f.assignee && (f.assignee === 'none' ? !!r.assignedTo : r.assignedTo !== f.assignee)) return false;
        if (f.health && (r.tracked === false || r.health?.band !== f.health || st === 'abandoned' || st === 'closed')) return false;
        if (f.stage && r.lifecycle !== f.stage) return false;
        if (f.type && r.transactionType !== f.type) return false;
        if (since) { const w = whenOf(r, f.status); if (!w || new Date(w).getTime() < since) return false; }
        return true;
      })
      .sort((a, b) => (RANK[a.health?.band] ?? 5) - (RANK[b.health?.band] ?? 5) || (a.propertyAddress ?? '').localeCompare(b.propertyAddress ?? ''));
  }, [pool, rows, q, f]);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((x) => ({ ...x, [k]: v }));

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
      <button type="button" className="cv-fold" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}><ChevronRight size={16} style={{ transform: listOpen ? 'rotate(90deg)' : undefined, transition: 'transform .12s' }} />Case List<span className="n">{rows ? list.length : ''}</span></button>
      {listOpen && (
        <div className="cv-bar">
          <input className="cv-search" placeholder="Reference, address or handler" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className={`cv-fbtn${filtersOpen || active ? ' on' : ''}`} aria-label="Filters" aria-expanded={filtersOpen} title="Filters" onClick={() => setFiltersOpen(!filtersOpen)}>
            <Filter size={18} />{active > 0 && <b>{active}</b>}
          </button>
        </div>
      )}
      {listOpen && filtersOpen && (
        <div className="cv-filters">
          <label>Status<select className="eg-sel" value={f.status} onChange={(e) => set('status', e.target.value as Status)}>
            <option value="open">Open</option><option value="completed">Completed</option><option value="abandoned">Abandoned</option><option value="closed">Closed</option><option value="all">All</option>
          </select></label>
          <label>{f.status === 'completed' ? 'Completed' : f.status === 'abandoned' ? 'Abandoned' : f.status === 'closed' ? 'Closed' : 'Opened'}<select className="eg-sel" value={f.within} onChange={(e) => set('within', e.target.value)}>
            <option value="">Any Time</option>{Object.entries(WITHIN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
          <label>Assigned To<select className="eg-sel" value={f.assignee} onChange={(e) => set('assignee', e.target.value)}>
            <option value="">Anyone</option><option value="none">Unassigned</option>{handlers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select></label>
          <label>Health<select className="eg-sel" value={f.health} onChange={(e) => set('health', e.target.value)}>
            <option value="">Any</option>{(Object.keys(RANK) as Array<keyof typeof HEALTH_LABEL>).map((b) => <option key={b} value={b}>{HEALTH_LABEL[b]}</option>)}
          </select></label>
          <label>Stage<select className="eg-sel" value={f.stage} onChange={(e) => set('stage', e.target.value)}>
            <option value="">Any</option>{stages.map((s) => <option key={s} value={s}>{LIFECYCLE_LABEL[s] ?? s}</option>)}
          </select></label>
          <label>Type<select className="eg-sel" value={f.type} onChange={(e) => set('type', e.target.value)}>
            <option value="">Any</option>{types.map((t) => <option key={t} value={t}>{TRANSACTION_LABEL[t] ?? t}</option>)}
          </select></label>
          {active > 0 && <button type="button" className="cv-clear" onClick={() => setF(NO_FILTERS)}>Clear Filters</button>}
        </div>
      )}
      {err && <div className="eg-err">{err}</div>}
      {!rows && !err && <div className="eg-sub">Loading…</div>}
      {listOpen && wantFinished && !finished && <div className="eg-sub">Loading…</div>}
      {listOpen && rows && list.length === 0 && (!wantFinished || finished) && <div className="cv-none">No cases match.</div>}
      {listOpen && list.length > 0 && <div className="cv-list">{list.map((r) => (
        <a key={r.matterId} className="cv-row" href={paths.matter(r.matterId)}>
          <House band={r.health?.band ?? 'normal'} size={24} />
          <span style={{ minWidth: 0 }}>
            <div className="cv-addr">{r.propertyAddress ?? r.matterRef ?? 'Case'}</div>
            <div className="cv-ref">{r.matterRef}{r.dayOfCase ? ` · day ${r.dayOfCase}` : ''}{r.sandbox ? <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: '#5A27E0', background: '#f3efff', borderRadius: 999, padding: '1px 6px' }}>SANDBOX</span> : null}</div>
          </span>
          <span className="cv-cell">{LIFECYCLE_LABEL[r.lifecycle] ?? r.lifecycle}</span>
          <span className="cv-cell">{r.assignedToName ?? 'Unassigned'}</span>
          {statusOf(r) === 'abandoned' || statusOf(r) === 'closed' ? <span className="cv-health" style={{ color: '#64748b' }}>{statusOf(r) === 'abandoned' ? 'Abandoned' : 'Closed'}</span> : <span className="cv-health" style={{ color: COLOUR[r.health?.band] ?? '#64748b' }}>{HEALTH_LABEL[r.health?.band] ?? ''}</span>}
        </a>
      ))}</div>}
    </div>
  );
}
