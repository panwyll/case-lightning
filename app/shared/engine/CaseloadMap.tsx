'use client';
import { useEffect, useMemo, useState } from 'react';
import { HEALTH_LABEL, type CaseToken, type HealthBand } from './types';
import { Minus, Plus, Search } from '@/app/shared/icons';

/**
 * The caseload map (docs/caseload-ux.md §1): every matter as a house on a sheet of paper,
 * standing on one of five ruled lines. No table, no columns, no board configuration —
 * a conveyancer with eighty matters should find the eight that need them in one look.
 *
 * Health is shown by colour AND by shape (a badge with its own silhouette), so the map
 * still reads in greyscale or with colour-blindness: the roof colour groups, the badge
 * identifies.
 */

/** The five bands on the paper. The engine's finer lifecycle values fold into these. */
export const BANDS = ['INSTRUCTION', 'PRE-EXCHANGE', 'READY', 'EXCHANGED', 'COMPLETION'] as const;
export type Band = (typeof BANDS)[number];
const BAND_OF: Record<string, Band> = {
  instructed: 'INSTRUCTION',
  pre_exchange: 'PRE-EXCHANGE',
  investigating: 'PRE-EXCHANGE',
  ready_to_exchange: 'READY',
  ready_to_complete: 'READY',
  exchanged: 'EXCHANGED',
  pre_completion: 'EXCHANGED',
  completed: 'COMPLETION',
  post_completion: 'COMPLETION',
  closed: 'COMPLETION',
  aborted: 'COMPLETION',
};
export const bandOf = (lifecycle: string): Band => BAND_OF[lifecycle] ?? 'INSTRUCTION';

const COLOUR: Record<HealthBand, { roof: string; wall: string; line: string }> = {
  normal: { roof: '#16a34a', wall: '#dcfce7', line: '#166534' },
  attention: { roof: '#f59e0b', wall: '#fef3c7', line: '#b45309' },
  delayed: { roof: '#ea580c', wall: '#ffedd5', line: '#9a3412' },
  blocked: { roof: '#475569', wall: '#e2e8f0', line: '#1e293b' },
  critical: { roof: '#dc2626', wall: '#fee2e2', line: '#991b1b' },
};

export const CASELOAD_CSS = `
.cm-head{display:flex;align-items:center;gap:12px;flex-wrap:nowrap;margin-bottom:14px;min-width:0}
.cm-head > *{flex-shrink:0}
.cm-head .cm-chips{flex:1 1 auto;min-width:0;overflow-x:auto;flex-wrap:nowrap;scrollbar-width:none}
.cm-chips{display:flex;gap:6px;flex-wrap:wrap}
.cm-chip{white-space:nowrap}
.cm-chip{display:inline-flex;align-items:center;gap:7px;border:1px solid #e2e8f0;background:#fff;border-radius:999px;padding:4px 12px 4px 6px;cursor:pointer;font-family:inherit;font-size:12.5px;color:#334155;line-height:1}
.cm-chip b{font-weight:800;font-variant-numeric:tabular-nums;color:#0f172a}
.cm-chip:hover{border-color:#cbd5e1;background:#f8fafc}
.cm-chip.on{border-color:#0f172a;background:#0f172a;color:#fff}
.cm-chip.on b{color:#fff}
.cm-chip.all{padding-left:12px}
.cm-board{background:#fdfcf8;border:1px solid #e7e2d4;border-radius:10px;box-shadow:0 1px 2px rgba(60,50,20,.06)}
.cm-row{display:grid;grid-template-columns:156px 1fr;align-items:center;min-height:52px;border-top:1px solid #ece7da}
.cm-row:first-child{border-top:0}
.cm-lab{padding:0 14px;font-size:10.5px;font-weight:800;letter-spacing:.12em;color:#8f8878;text-transform:uppercase;display:flex;gap:6px;border-right:1px solid #ece7da;align-self:stretch;align-items:center;white-space:nowrap}
.cm-lab .n{font-weight:600;letter-spacing:0;color:#b8b1a0;font-variant-numeric:tabular-nums}
.cm-houses{display:flex;flex-wrap:wrap;gap:4px;align-items:flex-end;padding:8px 12px}
.cm-cols{display:grid;min-width:0;align-self:stretch}
.cm-cell{border-left:1px solid #ece7da;min-height:36px;align-content:flex-start}
.cm-cell:first-child{border-left:0}
.cm-names{min-height:0;background:#faf8f3}
.cm-names .cm-lab{border-right:1px solid #ece7da}
.cm-name{padding:6px 12px;font-size:11.5px;font-weight:800;color:#5b5646;border-left:1px solid #ece7da;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cm-name:first-child{border-left:0}
.cm-name .n{margin-left:6px;font-weight:600;color:#b8b1a0;font-variant-numeric:tabular-nums}
.cm-compact .cm-board{background:#fff}
.cm-compact .cm-row{display:block;min-height:0;padding:8px 10px 6px}
.cm-compact .cm-lab{border-right:0;padding:0 0 4px;font-size:9.5px;letter-spacing:.08em;align-self:auto}
.cm-compact .cm-houses{padding:0;gap:3px}
.cm-zoom{display:inline-flex;align-items:center;border:1px solid #e2e8f0;border-radius:999px;background:#fff;overflow:hidden;margin-left:auto}
.cm-zoom button{border:0;background:none;padding:5px 9px;display:inline-flex;align-items:center;color:#475569;cursor:pointer}
.cm-zoom button:hover:not(:disabled){background:#f5f3ff;color:#5A27E0}
.cm-zoom button:disabled{color:#cbd5e1;cursor:default}
.cm-zoom .mag{border-left:1px solid #eef1f5;border-right:1px solid #eef1f5}
.cm-house{background:none;border:0;padding:0;cursor:pointer;line-height:0;border-radius:4px;transition:transform .08s ease}
.cm-house:hover,.cm-house:focus-visible{transform:translateY(-3px);outline:none}
.cm-house.dim{opacity:.18}
.cm-tip{position:fixed;z-index:60;pointer-events:none;background:#0f172a;color:#fff;border-radius:8px;padding:8px 10px;font-size:12px;max-width:290px;box-shadow:0 8px 24px rgba(15,23,42,.25)}
.cm-tip b{display:block;font-size:12.5px}
.cm-tip .m{color:#cbd5e1;font-size:11.5px}
@media (max-width:700px){.cm-row{grid-template-columns:1fr}.cm-lab{border-right:0;padding-top:8px}}
`;

/** One house. Colour groups; the badge's silhouette identifies, so it reads without colour. */
export function House({ band, size = 30, title, untracked = false }: { band: HealthBand; size?: number; title?: string; untracked?: boolean }) {
  if (untracked) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={`${title ? `${title} — ` : ''}not tracked yet`}>
        {title ? <title>{`${title} — not tracked by CONVEYi yet`}</title> : null}
        <path d="M1.6 9.6 L12 1.6 L22.4 9.6 Z" fill="none" stroke="#94a3b8" strokeWidth="1" strokeDasharray="2 1.6" strokeLinejoin="round" />
        <rect x="4" y="9.6" width="16" height="11.4" fill="none" stroke="#94a3b8" strokeWidth="1" strokeDasharray="2 1.6" />
      </svg>
    );
  }
  const c = COLOUR[band];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={`${title ? `${title} — ` : ''}${HEALTH_LABEL[band]}`}>
      {title ? <title>{`${title} — ${HEALTH_LABEL[band]}`}</title> : null}
      <ellipse cx="12" cy="22.3" rx="9" ry="1.1" fill="#0f172a" opacity=".12" />
      <rect x="15.2" y="3.4" width="2.4" height="4.4" rx=".4" fill={c.line} />
      <rect x="4.3" y="10" width="15.4" height="11.6" rx="1.2" fill={c.wall} stroke={c.line} strokeWidth=".9" />
      <path d="M2 11.2 L12 2.6 L22 11.2" fill={c.roof} stroke={c.line} strokeWidth=".9" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M2 11.2 L12 2.6 L22 11.2 Z" fill={c.roof} />
      <rect x="10" y="15" width="4" height="6.6" rx="1.8" fill={c.line} />
      <rect x="6.2" y="13" width="2.8" height="2.8" rx=".5" fill="#fff" stroke={c.line} strokeWidth=".7" />
      <rect x="15" y="13" width="2.8" height="2.8" rx=".5" fill="#fff" stroke={c.line} strokeWidth=".7" />
      {band === 'attention' && <g><circle cx="20" cy="4.5" r="4" fill="#f59e0b" stroke="#fff" strokeWidth="1.1" /><rect x="19.4" y="2.4" width="1.2" height="2.7" rx=".6" fill="#fff" /><circle cx="20" cy="6.2" r=".7" fill="#fff" /></g>}
      {band === 'delayed' && <g><circle cx="20" cy="4.5" r="4" fill="#ea580c" stroke="#fff" strokeWidth="1.1" /><path d="M20 2.4 V4.6 H21.7" stroke="#fff" strokeWidth="1.1" fill="none" strokeLinecap="round" /></g>}
      {band === 'blocked' && <g><circle cx="20" cy="4.5" r="4" fill="#334155" stroke="#fff" strokeWidth="1.1" /><rect x="17.9" y="3.9" width="4.2" height="1.3" rx=".6" fill="#fff" /></g>}
      {band === 'critical' && <g><path d="M20 0.6 L23.8 7.1 H16.2 Z" fill="#dc2626" stroke="#fff" strokeWidth="1.1" strokeLinejoin="round" /><rect x="19.45" y="2.9" width="1.1" height="2.2" rx=".55" fill="#fff" /><circle cx="20" cy="6" r=".65" fill="#fff" /></g>}
    </svg>
  );
}

const line = (t: CaseToken) => t.health.headline ?? `Day ${t.dayOfCase} · nothing outstanding`;
const isTracked = (t: CaseToken) => t.tracked !== false;

/** House sizes on the board, as a multiple of normal: a fifth to double. */
const ZOOM_STEPS = [0.2, 0.3, 0.45, 0.6, 0.8, 1, 1.25, 1.5, 1.75, 2];

export function CaseloadMap({ rows, rollup, onOpen, title, actions, compact = false, hideBoard = false, byHandler = false }: {
  /** A section inside a grouped board: smaller title, no filter chips. */
  compact?: boolean;
  /** Header only: the chips and controls, with the board drawn elsewhere. */
  hideBoard?: boolean;
  /** Split every row into a column per handler, names along the top, Unassigned last. */
  byHandler?: boolean;
  /** The page's title and controls share one row with the filter chips. */
  title: string;
  actions?: React.ReactNode;
  rows: CaseToken[];
  rollup: { total: number; normal: number; attention: number; delayed: number; blocked: number; critical: number; stuck: number; untracked?: number };
  onOpen: (matterId: string) => void;
}) {
  // The houses' size (a heads-up scatter of the caseload): a fifth of normal at least, double at most; remembered per viewer.
  const [zi, setZi] = useState<number>(ZOOM_STEPS.indexOf(1));
  useEffect(() => { try { const raw = window.localStorage.getItem('caseview-zoom'); const v = raw === null ? NaN : Number(raw); if (Number.isInteger(v) && v >= 0 && v < ZOOM_STEPS.length) setZi(v); } catch { /* default size */ } }, []);
  const setZoomAt = (n: number) => { const k = Math.min(ZOOM_STEPS.length - 1, Math.max(0, n)); setZi(k); try { window.localStorage.setItem('caseview-zoom', String(k)); } catch { /* per-viewer convenience */ } };
  const zoom = compact ? 1 : ZOOM_STEPS[zi];
  const [filter, setFilter] = useState<HealthBand | 'all'>('all');
  const [tip, setTip] = useState<{ t: CaseToken; x: number; y: number } | null>(null);

  const shows = (t: CaseToken) => filter === 'all' || (isTracked(t) && t.health.band === filter);
  // A filter shows only what matches: on a board of hundreds, greying the rest out does not help anyone find anything.
  const visible = useMemo(() => rows.filter(shows), [rows, filter]);

  const byBand = useMemo(() => {
    const m = new Map<Band, CaseToken[]>(BANDS.map((b) => [b, [] as CaseToken[]]));
    const rank: Record<HealthBand, number> = { critical: 0, blocked: 1, delayed: 2, attention: 3, normal: 4 };
    for (const r of visible) m.get(bandOf(r.lifecycle))!.push(r);
    // Tracked matters first (they carry news), worst first; untracked after, oldest first.
    for (const list of m.values()) list.sort((a, b) => Number(!isTracked(a)) - Number(!isTracked(b)) || rank[a.health.band] - rank[b.health.band] || b.dayOfCase - a.dayOfCase);
    return m;
  }, [visible]);

  const handlers = useMemo(() => {
    if (!byHandler) return [] as string[];
    const names = new Set<string>();
    // With a filter on, only the people who have matching cases get a column.
    for (const r of visible) names.add(r.assignedToName ?? 'Unassigned');
    return Array.from(names).sort((a, b) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)));
  }, [visible, byHandler]);
  const houses = (list: CaseToken[]) => list.map((t) => (
    <button
      key={t.matterId}
      type="button"
      className="cm-house"
      onClick={() => onOpen(t.matterId)}
      onMouseEnter={(e) => setTip({ t, x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => setTip({ t, x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setTip(null)}
      aria-label={`${t.propertyAddress ?? t.matterRef ?? 'Case'} — ${HEALTH_LABEL[t.health.band]}`}
    >
      <House band={t.health.band} size={Math.max(6, Math.round(28 * zoom))} title={t.propertyAddress ?? t.matterRef ?? undefined} />
    </button>
  ));
  const chip = (key: HealthBand | 'all', n: number, label: string) => (
    <button key={key} type="button" className={`cm-chip${filter === key ? ' on' : ''}${key === 'all' ? ' all' : ''}`} onClick={() => setFilter(filter === key ? 'all' : key)} aria-pressed={filter === key}>
      {key !== 'all' && <House band={key} size={20} />}
      <b>{n}</b> {label}
    </button>
  );

  return (
    <div onMouseLeave={() => setTip(null)} className={compact ? 'cm-compact' : undefined}>
      <style>{CASELOAD_CSS}</style>
      <div className="cm-head">
        {compact ? <h2 className="eg-h1" style={{ fontSize: 15 }}>{title}<span style={{ marginLeft: 8, color: '#94a3b8', fontWeight: 600, fontSize: 13 }}>{rows.length}</span></h2> : <h1 className="eg-h1">{title}</h1>}
        {!compact && <div className="cm-chips">
          {chip('all', rows.length, 'All')}
          {chip('normal', rollup.normal, 'On track')}
          {chip('attention', rollup.attention, 'Needs attention')}
          {chip('delayed', rollup.delayed, 'Delayed')}
          {chip('blocked', rollup.blocked, 'Blocked')}
          {chip('critical', rollup.critical, 'Critical')}
        </div>}
        {!compact && !hideBoard && (
          <div className="cm-zoom" role="group" aria-label="House size">
            <button type="button" aria-label="Smaller" disabled={zi === 0} onClick={() => setZoomAt(zi - 1)}><Minus size={16} /></button>
            <button type="button" aria-label="Normal size" title={`${Math.round(zoom * 100)}%`} className="mag" onClick={() => setZoomAt(ZOOM_STEPS.indexOf(1))}><Search size={16} /></button>
            <button type="button" aria-label="Larger" disabled={zi === ZOOM_STEPS.length - 1} onClick={() => setZoomAt(zi + 1)}><Plus size={16} /></button>
          </div>
        )}
        {actions && <div style={{ marginLeft: compact || hideBoard ? 'auto' : undefined }}>{actions}</div>}
      </div>
      {!hideBoard && <div className="cm-board">
        {byHandler && handlers.length > 0 && (
          <div className="cm-row cm-names">
            <div className="cm-lab" />
            <div className="cm-cols" style={{ gridTemplateColumns: `repeat(${handlers.length}, minmax(0, 1fr))` }}>
              {handlers.map((h) => <div key={h} className="cm-name">{h}<span className="n">{visible.filter((r) => (r.assignedToName ?? 'Unassigned') === h).length}</span></div>)}
            </div>
          </div>
        )}
        {BANDS.filter((b) => !compact || (byBand.get(b)?.length ?? 0) > 0).map((b) => {
          const list = byBand.get(b) ?? [];
          return (
            <div key={b} className="cm-row">
              <div className="cm-lab">{b}<span className="n">{list.length}</span></div>
              {byHandler && handlers.length > 0 ? (
                <div className="cm-cols" style={{ gridTemplateColumns: `repeat(${handlers.length}, minmax(0, 1fr))` }}>
                  {handlers.map((h) => <div key={h} className="cm-houses cm-cell">{houses(list.filter((t) => (t.assignedToName ?? 'Unassigned') === h))}</div>)}
                </div>
              ) : (
                <div className="cm-houses">{houses(list)}</div>
              )}
            </div>
          );
        })}
      </div>}

      {tip && (
        <div className="cm-tip" style={{ left: Math.min(tip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 310), top: tip.y + 16 }}>
          <b>{tip.t.propertyAddress ?? tip.t.matterRef ?? 'Case'}</b>
          <div className="m">{tip.t.matterRef ?? ''} · day {tip.t.dayOfCase} · {HEALTH_LABEL[tip.t.health.band]}</div>
          <div style={{ marginTop: 4 }}>{line(tip.t)}</div>
        </div>
      )}
    </div>
  );
}
