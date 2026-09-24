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
  normal: { roof: '#94a3b8', wall: '#ffffff', line: '#64748b' },
  attention: { roof: '#f59e0b', wall: '#fffbeb', line: '#b45309' },
  delayed: { roof: '#ea580c', wall: '#fff7ed', line: '#9a3412' },
  blocked: { roof: '#475569', wall: '#e2e8f0', line: '#1e293b' },
  critical: { roof: '#dc2626', wall: '#fef2f2', line: '#991b1b' },
};

export const CASELOAD_CSS = `
.cm-paper{background:#fdfcf8;border:1px solid #e7e2d4;border-radius:4px;box-shadow:0 1px 2px rgba(60,50,20,.08),0 8px 24px -16px rgba(60,50,20,.25);padding:20px 22px 8px}
.cm-band{padding:0 0 4px}
.cm-band-label{font-size:10.5px;font-weight:800;letter-spacing:.12em;color:#a8a294;text-transform:uppercase;display:flex;align-items:baseline;gap:8px}
.cm-band-label .n{font-weight:600;letter-spacing:0;color:#c3bdae;font-variant-numeric:tabular-nums}
.cm-houses{display:flex;flex-wrap:wrap;gap:5px;align-items:flex-end;min-height:38px;padding:8px 0 5px}
.cm-rule{border:0;border-top:1px solid #ded8c8;margin:0 0 14px}
.cm-house{background:none;border:0;padding:0;cursor:pointer;line-height:0;border-radius:4px;transition:transform .08s ease}
.cm-house:hover,.cm-house:focus-visible{transform:translateY(-3px);outline:none}
.cm-house.dim{opacity:.22}
.cm-house.sel svg{filter:drop-shadow(0 0 0 2px #0f172a)}
.cm-empty{font-size:12px;color:#c3bdae;padding:10px 0 4px;font-style:italic}
.cm-strip{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
.cm-stat{border:1px solid #e6e8ee;background:#fff;border-radius:10px;padding:7px 12px;cursor:pointer;font-family:inherit;text-align:left;min-width:104px}
.cm-stat.on{border-color:#0f172a;box-shadow:inset 0 0 0 1px #0f172a}
.cm-stat b{display:block;font-size:19px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1}
.cm-stat span{font-size:11px;color:#64748b}
.cm-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:#94a3b8;padding:2px 2px 14px}
.cm-legend span{display:inline-flex;align-items:center;gap:5px}
.cm-exc{background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden}
.cm-exc-row{display:flex;gap:10px;align-items:flex-start;padding:11px 14px;border-top:1px solid #f1f5f9;cursor:pointer;width:100%;background:none;border-left:0;border-right:0;border-bottom:0;font-family:inherit;text-align:left}
.cm-exc-row:first-child{border-top:0}
.cm-exc-row:hover{background:#fafafa}
.cm-exc-addr{font-weight:700;font-size:13.5px}
.cm-exc-line{font-size:12.5px;color:#475569;margin-top:2px}
.cm-exc-meta{font-size:11.5px;color:#94a3b8;margin-top:2px}
.cm-why{padding:0 14px 14px 46px;font-size:12.5px;color:#334155;background:#fafafa;border-top:1px solid #f1f5f9}
.cm-why ol{margin:8px 0 0;padding-left:18px}
.cm-why li{margin:3px 0}
.cm-why .sug{margin-top:10px;padding:8px 10px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;color:#4c1d95}
.cm-tip{position:fixed;z-index:60;pointer-events:none;background:#0f172a;color:#fff;border-radius:8px;padding:8px 10px;font-size:12px;max-width:290px;box-shadow:0 8px 24px rgba(15,23,42,.25)}
.cm-tip b{display:block;font-size:12.5px}
.cm-tip .m{color:#cbd5e1;font-size:11.5px}
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
      <path d="M1.6 9.6 L12 1.6 L22.4 9.6 Z" fill={c.roof} stroke={c.line} strokeWidth="1" strokeLinejoin="round" />
      <rect x="4" y="9.6" width="16" height="11.4" fill={c.wall} stroke={c.line} strokeWidth="1" />
      <rect x="10.2" y="14.4" width="3.6" height="6.6" fill={c.line} opacity=".55" />
      {band === 'attention' && <g><circle cx="20" cy="4.5" r="4" fill="#f59e0b" stroke="#fff" strokeWidth="1.1" /><rect x="19.4" y="2.4" width="1.2" height="2.7" rx=".6" fill="#fff" /><circle cx="20" cy="6.2" r=".7" fill="#fff" /></g>}
      {band === 'delayed' && <g><circle cx="20" cy="4.5" r="4" fill="#ea580c" stroke="#fff" strokeWidth="1.1" /><path d="M20 2.4 V4.6 H21.7" stroke="#fff" strokeWidth="1.1" fill="none" strokeLinecap="round" /></g>}
      {band === 'blocked' && <g><circle cx="20" cy="4.5" r="4" fill="#334155" stroke="#fff" strokeWidth="1.1" /><rect x="17.9" y="3.9" width="4.2" height="1.3" rx=".6" fill="#fff" /></g>}
      {band === 'critical' && <g><path d="M20 0.6 L23.8 7.1 H16.2 Z" fill="#dc2626" stroke="#fff" strokeWidth="1.1" strokeLinejoin="round" /><rect x="19.45" y="2.9" width="1.1" height="2.2" rx=".55" fill="#fff" /><circle cx="20" cy="6" r=".65" fill="#fff" /></g>}
    </svg>
  );
}

const line = (t: CaseToken) => t.health.headline ?? `Day ${t.dayOfCase} · nothing outstanding`;
const isTracked = (t: CaseToken) => t.tracked !== false;

export function CaseloadMap({ rows, rollup, onOpen }: {
  rows: CaseToken[];
  rollup: { total: number; normal: number; attention: number; delayed: number; blocked: number; critical: number; stuck: number; untracked?: number };
  onOpen: (matterId: string) => void;
}) {
  const [filter, setFilter] = useState<HealthBand | 'all' | 'stuck' | 'untracked'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [tip, setTip] = useState<{ t: CaseToken; x: number; y: number } | null>(null);

  // An untracked matter only ever matches "all" and "not tracked yet": it has no health, so
  // it must never be counted as moving normally.
  const shows = (t: CaseToken) =>
    filter === 'all' ? true
    : filter === 'untracked' ? !isTracked(t)
    : !isTracked(t) ? false
    : filter === 'stuck' ? t.health.band === 'delayed' || t.health.band === 'blocked'
    : t.health.band === filter;

  const byBand = useMemo(() => {
    const m = new Map<Band, CaseToken[]>(BANDS.map((b) => [b, [] as CaseToken[]]));
    const rank: Record<HealthBand, number> = { critical: 0, blocked: 1, delayed: 2, attention: 3, normal: 4 };
    for (const r of rows) m.get(bandOf(r.lifecycle))!.push(r);
    // Tracked matters first (they carry news), worst first; untracked after, oldest first.
    for (const list of m.values()) list.sort((a, b) => Number(!isTracked(a)) - Number(!isTracked(b)) || rank[a.health.band] - rank[b.health.band] || b.dayOfCase - a.dayOfCase);
    return m;
  }, [rows]);

  const exceptions = useMemo(
    () => rows.filter((r) => isTracked(r) && r.health.band !== 'normal' && shows(r)).sort((a, b) => {
      const rank: Record<HealthBand, number> = { critical: 0, blocked: 1, delayed: 2, attention: 3, normal: 4 };
      return rank[a.health.band] - rank[b.health.band] || (b.health.counts.waiting - a.health.counts.waiting);
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, filter]
  );

  const untracked = rollup.untracked ?? rows.filter((r) => !isTracked(r)).length;
  const trackedCount = rows.length - untracked;
  const stat = (key: HealthBand | 'all' | 'stuck' | 'untracked', n: number, label: string, colour: string) => (
    <button key={key} type="button" className={`cm-stat${filter === key ? ' on' : ''}`} onClick={() => setFilter(filter === key ? 'all' : key)} aria-pressed={filter === key}>
      <b style={{ color: n ? colour : '#cbd5e1' }}>{n}</b>
      <span>{label}</span>
    </button>
  );

  return (
    <div onMouseLeave={() => setTip(null)}>
      <style>{CASELOAD_CSS}</style>

      {/* Oversight strip — the counts double as filters. */}
      <div className="cm-strip">
        {stat('all', rows.length, 'open cases', '#0f172a')}
        {stat('normal', rollup.normal, 'on track', '#16a34a')}
        {stat('attention', rollup.attention, 'need attention', '#b45309')}
        {stat('stuck', rollup.stuck, 'stuck', '#9a3412')}
        {stat('critical', rollup.critical, 'critical', '#b91c1c')}
      </div>

      <div className="cm-paper">
        {BANDS.map((b) => {
          const list = byBand.get(b) ?? [];
          const visible = list.filter(shows);
          return (
            <div key={b} className="cm-band">
              <div className="cm-band-label">{b}<span className="n">{list.length}</span></div>
              <div className="cm-houses">
                {list.length === 0 && <span className="cm-empty">nothing here</span>}
                {list.map((t) => (
                  <button
                    key={t.matterId}
                    type="button"
                    className={`cm-house${shows(t) ? '' : ' dim'}${openId === t.matterId ? ' sel' : ''}`}
                    onClick={() => onOpen(t.matterId)}
                    onMouseEnter={(e) => setTip({ t, x: e.clientX, y: e.clientY })}
                    onMouseMove={(e) => setTip({ t, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setTip(null)}
                    onFocus={() => setOpenId(t.matterId)}
                    aria-label={`${t.propertyAddress ?? t.matterRef ?? 'Matter'} — ${isTracked(t) ? HEALTH_LABEL[t.health.band] : 'not tracked yet'}`}
                  >
                    <House band={t.health.band} untracked={!isTracked(t)} title={t.propertyAddress ?? t.matterRef ?? undefined} />
                  </button>
                ))}
                {list.length > 0 && visible.length === 0 && <span className="cm-empty">none in this filter</span>}
              </div>
              <hr className="cm-rule" />
            </div>
          );
        })}
        <div className="cm-legend">
          {(['normal', 'attention', 'delayed', 'blocked', 'critical'] as HealthBand[]).map((b) => (
            <span key={b}><House band={b} size={20} /> {HEALTH_LABEL[b]}</span>
          ))}
        </div>
      </div>

      {/* Exceptions — click one and it explains itself. */}
      <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: '#64748b', margin: '22px 0 8px' }}>
        {exceptions.length === 0 ? (trackedCount === 0 ? 'Not tracking anything yet' : 'Nothing needs you') : `Needs someone (${exceptions.length})`}
      </h2>
      {exceptions.length === 0 ? (
        // Never claim "every case is moving normally" about cases the engine is not following.
        trackedCount === 0 ? (
          <div className="eg-empty">These are your firm’s open matters. CONVEYi isn’t following any of them yet, so it can’t tell you which need you. Open one and enrol it to start.</div>
        ) : (
          <div className="eg-empty">Every case CONVEYi is following is moving normally.{untracked > 0 ? ` ${untracked} more ${untracked === 1 ? 'isn’t' : 'aren’t'} tracked yet.` : ''}</div>
        )
      ) : (
        <div className="cm-exc">
          {exceptions.map((t) => (
            <div key={t.matterId}>
              <button type="button" className="cm-exc-row" onClick={() => setOpenId(openId === t.matterId ? null : t.matterId)} aria-expanded={openId === t.matterId}>
                <House band={t.health.band} size={26} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="cm-exc-addr">{t.propertyAddress ?? t.matterRef ?? t.matterId}</span>
                  <div className="cm-exc-line">{line(t)}</div>
                  <div className="cm-exc-meta">
                    {t.matterRef ? `${t.matterRef} · ` : ''}day {t.dayOfCase} · {t.health.counts.waiting} waiting · {t.health.counts.openIssues} open issue{t.health.counts.openIssues === 1 ? '' : 's'}
                    {t.health.reasonCount > 1 ? ` · ${t.health.reasonCount} reasons` : ''}
                  </div>
                </span>
                <span style={{ color: '#94a3b8', fontSize: 12 }}>{openId === t.matterId ? 'Hide' : 'Why?'}</span>
              </button>
              {openId === t.matterId && (
                <div className="cm-why">
                  <ol>{t.health.why.map((w, i) => <li key={i}>{w}</li>)}</ol>
                  {t.health.suggested && <div className="sug"><b>Suggested next action:</b> {t.health.suggested}</div>}
                  <div style={{ marginTop: 10 }}>
                    <button className="eg-btn primary" onClick={() => onOpen(t.matterId)}>Open the case →</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

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
