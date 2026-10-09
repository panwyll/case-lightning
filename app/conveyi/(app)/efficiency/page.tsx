'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { paths } from '@/lib/paths';
import { flushAttention } from '@/app/shared/epa/useAttention';
import type { EpaReport, EpaWeek } from '@/lib/server/epa/report';

/**
 * EPA (docs/epa.md): efficiency (the share of time on work only a conveyancer can do), the Pareto of the rest with the
 * CONVEYi action that takes each, the weekly monitor, focus, queue times and how much of it is measured.
 */
interface Res {
  person: { userId: string; name: string }; isOwn: boolean; admin: boolean;
  people: Array<{ id: string; name: string }> | null;
  report: EpaReport & { measuredFrom: string | null };
  spec: Record<string, { label: string; rag: string; what: string }>;
}

const CSS = `
.ep{padding:18px 22px;max-width:1240px}
.ep h1{font-size:21px;font-weight:800;margin:0}
.ep h2{font-size:15px;font-weight:800;margin:22px 0 8px;color:#0f172a}
.ep-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.ep-head .r{margin-left:auto;display:flex;gap:8px;align-items:center}
.ep-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:14px}
.ep-tile{background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:10px 12px}
.ep-tile .k{font-size:11.5px;color:#64748b;font-weight:700}
.ep-tile .v{font-size:22px;font-weight:800;color:#0f172a;margin-top:2px}
.ep-tile .s{font-size:12px;color:#64748b;margin-top:2px}
.ep-tile.hi{border-color:#c7b8fb;background:#faf8ff}
.ep-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:16px}
.ep-card{background:#fff;border:1px solid #e6e8ee;border-radius:14px;padding:12px 14px}
.ep table{border-collapse:collapse;width:100%;font-size:13px}
.ep th{text-align:right;padding:7px 9px;background:#f8fafc;color:#334155;font-weight:700;white-space:nowrap;border-bottom:1px solid #e8eaf0}
.ep td{text-align:right;padding:6px 9px;border-bottom:1px solid #f1f3f7;white-space:nowrap}
.ep th:first-child,.ep td:first-child{text-align:left;white-space:normal}
.ep-par{display:grid;grid-template-columns:180px minmax(0,1fr) 60px 300px;gap:8px;align-items:center;font-size:13px;padding:5px 0;border-bottom:1px solid #f1f3f7}
.ep-par .bar{height:14px;border-radius:4px;background:#eef1f5;position:relative;overflow:hidden}
.ep-par .bar i{position:absolute;left:0;top:0;bottom:0;border-radius:4px}
.ep-par .bar i.red{background:#ef4444}.ep-par .bar i.amber{background:#f59e0b}
.ep-par .cum{position:absolute;top:0;bottom:0;width:2px;background:#5A27E0}
.ep-par .h{text-align:right;font-weight:700}
.ep-par .act{font-size:12.5px;color:#334155}
.ep-par .act a{color:#5A27E0;font-weight:700;text-decoration:none}
.ep-par.part{padding-left:18px;font-size:12.5px;color:#475569}
.ep-lvl{display:inline-block;font-size:11px;font-weight:800;border-radius:999px;padding:1px 8px;margin-right:6px}
.ep-lvl.propose{background:#fef3c7;color:#92400e}.ep-lvl.assist{background:#e0e7ff;color:#3730a3}.ep-lvl.auto{background:#dcfce7;color:#166534}
.ep-rag{display:flex;height:12px;border-radius:99px;overflow:hidden;background:#eef1f5;min-width:140px}
.ep-rag i{display:block;height:100%}
.ep-rag .red{background:#ef4444}.ep-rag .amber{background:#f59e0b}.ep-rag .green{background:#16a34a}
.ep-none{color:#64748b;font-size:13px;padding:10px 0}
.ep-err{color:#b91c1c;font-size:13px}
@media (max-width:1100px){.ep-grid{grid-template-columns:1fr}.ep-par{grid-template-columns:140px minmax(0,1fr) 50px}.ep-par .act{grid-column:1/-1}}
`;

const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const hrs = (x: number | null | undefined) => (x == null ? '—' : x > 0 && x < 0.05 ? '<0.1h' : `${x.toFixed(1)}h`);
const title = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const wk = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const LEVEL: Record<string, string> = { propose: 'Propose', assist: 'Assist', auto: 'Auto' };

export default function EfficiencyPage() {
  return <Suspense fallback={<div style={{ padding: 20, color: '#64748b' }}>Loading…</div>}><Efficiency /></Suspense>;
}

function Efficiency() {
  const params = useSearchParams();
  const router = useRouter();
  const person = params.get('person') ?? '';
  const [weeks, setWeeks] = useState(8);
  const [res, setRes] = useState<Res | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setErr(null);
    void flushAttention().then(() => api<Res>(`/epa?weeks=${weeks}${person ? `&person=${encodeURIComponent(person)}` : ''}`).then(setRes).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the figures.')));
  }, [weeks, person]);

  const r = res?.report;
  const withTime = r ? r.weeks.filter((w) => w.measures.efficiency != null) : [];
  const now = withTime[withTime.length - 1] ?? null;
  const prev = withTime[withTime.length - 2] ?? null;
  const m = now?.measures;
  const delta = now && prev && now.measures.efficiency != null && prev.measures.efficiency != null ? Math.round((now.measures.efficiency - prev.measures.efficiency) * 100) : null;
  const maxShare = r?.pareto[0]?.share ?? 1;

  return (
    <div className="ep">
      <style>{ENGINE_CSS + CSS}</style>
      <div className="ep-head">
        <h1>Efficiency</h1>
        <div className="r">
          {res?.people && (
            <select value={person || res.person.userId} onChange={(e) => router.replace(e.target.value === res.person.userId && res.isOwn ? paths.efficiency : `${paths.efficiency}?person=${e.target.value}`)} aria-label="Person">
              {res.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} aria-label="Weeks">
            {[4, 8, 13, 26].map((n) => <option key={n} value={n}>Last {n} Weeks</option>)}
          </select>
        </div>
      </div>
      {err && <p className="ep-err">{err}</p>}
      {!res && !err && <p className="ep-none">Loading…</p>}
      {r && (
        <>
          <div className="ep-tiles">
            <div className="ep-tile hi"><div className="k">Efficiency{now ? ` · Week Of ${wk(now.start)}` : ''}</div><div className="v">{pct(m?.efficiency)}</div><div className="s">{delta == null ? 'Conveyancer-only work' : `${delta >= 0 ? '+' : ''}${delta} pts on last week`}</div></div>
            <div className="ep-tile"><div className="k">Baseline</div><div className="v">{pct(r.baselineEfficiency)}</div><div className="s">{r.baselineEfficiency == null ? 'No mailbox scan yet' : 'From the mailbox scan'}</div></div>
            <div className="ep-tile"><div className="k">Red · Amber · Green</div><div className="v" style={{ fontSize: 18 }}>{now ? `${hrs(now.hours.red)} · ${hrs(now.hours.amber)} · ${hrs(now.hours.green)}` : '—'}</div></div>
            <div className="ep-tile"><div className="k">Measured</div><div className="v">{pct(m?.measuredShare)}</div><div className="s">{now ? `${hrs(now.hours.unattributed)} Unattributed` : 'No time recorded yet'}</div></div>
          </div>

          <div>
            <div>
              <h2>Pareto{r.paretoWeek ? ` · Week Of ${wk(r.paretoWeek)}` : ''}</h2>
              <div className="ep-card">
                {!r.pareto.length && <p className="ep-none">No red or amber time recorded yet.</p>}
                {r.pareto.map((b) => (
                  <div key={b.kind}>
                    <div className="ep-par">
                      <span><b>{b.label}</b></span>
                      <span className="bar"><i className={b.rag} style={{ width: `${(b.share / maxShare) * 100}%` }} /><span className="cum" style={{ left: `calc(${Math.min(100, b.cumulative * 100)}% - 1px)` }} title={`${pct(b.cumulative)} cumulative`} /></span>
                      <span className="h">{hrs(b.hours)}</span>
                      <span className="act">
                        {b.action
                          ? <><span className={`ep-lvl ${b.action.level}`}>{LEVEL[b.action.level]}</span>{b.action.sendsUnasked ? `${title(b.action.label)} Send` : <a href={paths.rules}>Set {title(b.action.label)} To Send</a>}</>
                          : b.kind === 'checking_drafts' ? 'Per action below' : 'No CONVEYi action yet'}
                      </span>
                    </div>
                    {b.parts?.map((p) => (
                      <div key={p.action} className="ep-par part">
                        <span>{title(p.label)}</span><span /><span className="h">{hrs(p.hours)}</span>
                        <span className="act">{p.level ? <><span className={`ep-lvl ${p.level}`}>{LEVEL[p.level]}</span><a href={paths.rules}>Change Level</a></> : null}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="ep-grid">
            <div>
              <h2>Focus</h2>
              <div className="ep-tiles" style={{ marginTop: 0, gridTemplateColumns: 'repeat(2,minmax(0,1fr))' }}>
                <div className="ep-tile"><div className="k">Switches Per Hour</div><div className="v">{m?.switchesPerHour == null ? '—' : m.switchesPerHour.toFixed(1)}</div></div>
                <div className="ep-tile"><div className="k">Median Focus Block</div><div className="v">{m?.medianBlockMinutes == null ? '—' : `${Math.round(m.medianBlockMinutes)} min`}</div></div>
                <div className="ep-tile"><div className="k">Time In 25+ Min Blocks</div><div className="v">{pct(m?.longBlockShare)}</div></div>
                <div className="ep-tile"><div className="k">After Hours</div><div className="v">{pct(m?.afterHoursShare)}</div></div>
              </div>
            </div>
            <div>
              <h2>Queue</h2>
              <div className="ep-card">
                {!r.queue.length ? <p className="ep-none">No tasks closed in these weeks.</p> : (
                  <table>
                    <thead><tr><th>Kind</th><th>Done</th><th>Median Wait</th><th>85th Percentile</th></tr></thead>
                    <tbody>{r.queue.map((q) => <tr key={q.kind}><td>{q.label}</td><td>{q.done}</td><td>{hrs(q.medianHours)}</td><td>{hrs(q.p85Hours)}</td></tr>)}</tbody>
                  </table>
                )}
              </div>
            </div>
          </div>

          <h2>Monitor</h2>
          <div className="ep-card">
            <table>
              <thead><tr><th>Week</th><th>Efficiency</th><th>Red</th><th>Amber</th><th>Green</th><th>Unattributed</th><th>Measured</th><th>Switches / Hour</th><th style={{ textAlign: 'left' }}>Split</th></tr></thead>
              <tbody>{[...r.weeks].reverse().map((w) => <WeekRow key={w.start} w={w} />)}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function WeekRow({ w }: { w: EpaWeek }) {
  const t = w.hours.red + w.hours.amber + w.hours.green;
  return (
    <tr>
      <td>{wk(w.start)}</td>
      <td><b>{pct(w.measures.efficiency)}</b></td>
      <td>{hrs(w.hours.red)}</td><td>{hrs(w.hours.amber)}</td><td>{hrs(w.hours.green)}</td>
      <td>{hrs(w.hours.unattributed)}</td>
      <td>{pct(w.measures.measuredShare)}</td>
      <td>{w.measures.switchesPerHour == null ? '—' : w.measures.switchesPerHour.toFixed(1)}</td>
      <td style={{ textAlign: 'left' }}>{t > 0 ? <span className="ep-rag">{(['red', 'amber', 'green'] as const).map((k) => <i key={k} className={k} style={{ width: `${(w.hours[k] / t) * 100}%` }} />)}</span> : '—'}</td>
    </tr>
  );
}
