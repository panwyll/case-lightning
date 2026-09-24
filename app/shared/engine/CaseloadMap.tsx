'use client';
import { useMemo, useState } from 'react';
import { HEALTH_LABEL, type CaseToken, type HealthBand } from './types';

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
.cm-head{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:14px}
.cm-chips{display:flex;gap:6px;flex-wrap:wrap}
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

export function CaseloadMap({ rows, rollup, onOpen, title, actions }: {
  /** The page's title and controls share one row with the filter chips. */
  title: string;
  actions?: React.ReactNode;
  rows: CaseToken[];
  rollup: { total: number; normal: number; attention: number; delayed: number; blocked: number; critical: number; stuck: number; untracked?: number };
  onOpen: (matterId: string) => void;
}) {
  const [filter, setFilter] = useState<HealthBand | 'all'>('all');
  const [tip, setTip] = useState<{ t: CaseToken; x: number; y: number } | null>(null);

  const shows = (t: CaseToken) => filter === 'all' || (isTracked(t) && t.health.band === filter);

  const byBand = useMemo(() => {
    const m = new Map<Band, CaseToken[]>(BANDS.map((b) => [b, [] as CaseToken[]]));
    const rank: Record<HealthBand, number> = { critical: 0, blocked: 1, delayed: 2, attention: 3, normal: 4 };
    for (const r of rows) m.get(bandOf(r.lifecycle))!.push(r);
    // Tracked matters first (they carry news), worst first; untracked after, oldest first.
    for (const list of m.values()) list.sort((a, b) => Number(!isTracked(a)) - Number(!isTracked(b)) || rank[a.health.band] - rank[b.health.band] || b.dayOfCase - a.dayOfCase);
    return m;
  }, [rows]);

  const chip = (key: HealthBand | 'all', n: number, label: string) => (
    <button key={key} type="button" className={`cm-chip${filter === key ? ' on' : ''}${key === 'all' ? ' all' : ''}`} onClick={() => setFilter(filter === key ? 'all' : key)} aria-pressed={filter === key}>
      {key !== 'all' && <House band={key} size={20} />}
      <b>{n}</b> {label}
    </button>
  );

  return (
    <div onMouseLeave={() => setTip(null)}>
      <style>{CASELOAD_CSS}</style>
      <div className="cm-head">
        <h1 className="eg-h1">{title}</h1>
        <div className="cm-chips">
          {chip('all', rows.length, 'All')}
          {chip('normal', rollup.normal, 'On track')}
          {chip('attention', rollup.attention, 'Needs attention')}
          {chip('delayed', rollup.delayed, 'Delayed')}
          {chip('blocked', rollup.blocked, 'Blocked')}
          {chip('critical', rollup.critical, 'Critical')}
        </div>
        {actions && <div style={{ marginLeft: 'auto' }}>{actions}</div>}
      </div>
      <div className="cm-board">
        {BANDS.map((b) => {
          const list = byBand.get(b) ?? [];
          return (
            <div key={b} className="cm-row">
              <div className="cm-lab">{b}<span className="n">{list.length}</span></div>
              <div className="cm-houses">
                {list.map((t) => (
                  <button
                    key={t.matterId}
                    type="button"
                    className={`cm-house${shows(t) ? '' : ' dim'}`}
                    onClick={() => onOpen(t.matterId)}
                    onMouseEnter={(e) => setTip({ t, x: e.clientX, y: e.clientY })}
                    onMouseMove={(e) => setTip({ t, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setTip(null)}
                    aria-label={`${t.propertyAddress ?? t.matterRef ?? 'Matter'} — ${HEALTH_LABEL[t.health.band]}`}
                  >
                    <House band={t.health.band} size={28} title={t.propertyAddress ?? t.matterRef ?? undefined} />
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {tip && (
        <div className="cm-tip" style={{ left: Math.min(tip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 310), top: tip.y + 16 }}>
          <b>{tip.t.propertyAddress ?? tip.t.matterRef ?? 'Matter'}</b>
          <div className="m">{tip.t.matterRef ?? ''} · day {tip.t.dayOfCase} · {HEALTH_LABEL[tip.t.health.band]}</div>
          <div style={{ marginTop: 4 }}>{line(tip.t)}</div>
        </div>
      )}
    </div>
  );
}
