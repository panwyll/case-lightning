'use client';
/**
 * The firm's analytics page (lib/server/analytics/kpis.ts, docs/analytics.md). It starts with what to
 * read first, then this month's pace, the two-year trend, where cases wait, our own turnaround, the cases to
 * look at, and each person against their own target and past (listed by name, not ranked).
 */
import { useMemo } from 'react';
import type { AnalyticsReport, PersonRow, Stat } from '@/lib/server/analytics/kpis';

const CSS = `
.an{max-width:1360px;color:#0f172a}
.an-top{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.an-top h1{font-size:20px;font-weight:800;margin:0 auto 0 0}
.an-sel{border:1px solid #cbd5e1;border-radius:8px;padding:7px 36px 7px 10px;font:inherit;font-size:13px;background:#fff}
.an-card{background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:16px 18px;min-width:0}
.an-h{font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#64748b;margin:0 0 10px;display:flex;align-items:center;gap:8px}
.an-h .r{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:600;color:#94a3b8}
.an-grid{display:grid;gap:14px;margin-bottom:14px}
.an-g4{grid-template-columns:repeat(4,minmax(0,1fr))}
.an-g2{grid-template-columns:repeat(2,minmax(0,1fr))}
.an-g3{grid-template-columns:2fr 1fr}
.an-ins{margin:0;padding:0;list-style:none;display:grid;gap:8px}
.an-ins li{font-size:14px;line-height:1.5;padding-left:16px;position:relative}
.an-ins li:before{content:'';position:absolute;left:0;top:8px;width:7px;height:7px;border-radius:99px;background:#5A27E0}
.an-big{font-size:30px;font-weight:800;line-height:1.1;letter-spacing:-.01em}
.an-big small{font-size:14px;font-weight:600;color:#64748b;margin-left:6px;letter-spacing:0}
.an-sub{font-size:12.5px;color:#64748b;margin-top:6px;line-height:1.6}
.an-sub b{color:#0f172a;font-weight:700}
.an-up{color:#15803d;font-weight:700}.an-down{color:#b91c1c;font-weight:700}
.an-bar{position:relative;height:10px;background:#f1f5f9;border-radius:99px;margin-top:10px;overflow:visible}
.an-bar i{position:absolute;top:0;bottom:0;left:0;border-radius:99px}
.an-bar .t{position:absolute;top:-4px;bottom:-4px;width:2px;background:#0f172a}
.an-stack{display:flex;height:22px;border-radius:6px;overflow:hidden;margin:4px 0 12px}
.an-stack div{height:100%}
.an-leg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 16px}
.an-leg div{display:flex;align-items:center;gap:8px;font-size:13px}
.an-leg i{width:10px;height:10px;border-radius:3px;flex:none}
.an-leg span{margin-left:auto;color:#64748b;font-variant-numeric:tabular-nums}
.an-t{width:100%;border-collapse:collapse;font-size:13px}
.an-t th{text-align:left;font-size:11.5px;font-weight:700;color:#64748b;padding:6px 8px;border-bottom:1px solid #e6e8ee;white-space:nowrap}
.an-t td{padding:8px;border-bottom:1px solid #f1f5f9;vertical-align:middle;font-variant-numeric:tabular-nums}
.an-t tr:last-child td{border-bottom:0}
.an-t .num{text-align:right}
.an-t a,.an-link{color:#5A27E0;font-weight:700;text-decoration:none;cursor:pointer;background:none;border:0;padding:0;font:inherit}
.an-thin{color:#94a3b8}
.an-mini{display:inline-block;width:64px;height:6px;background:#f1f5f9;border-radius:99px;position:relative;vertical-align:middle;margin-right:6px}
.an-mini i{position:absolute;left:0;top:0;bottom:0;border-radius:99px;background:#5A27E0}
.an-kv{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.an-kv b{display:block;font-size:20px;font-weight:800}
.an-kv span{font-size:12px;color:#64748b}
.an-q{font-size:13.5px;line-height:1.5;border-left:3px solid #e2e8f0;padding:2px 0 2px 10px;margin:0 0 10px}
.an-q small{display:block;color:#94a3b8;font-size:12px}
@media (max-width:1100px){.an-g4{grid-template-columns:repeat(2,minmax(0,1fr))}.an-g3,.an-g2{grid-template-columns:1fr}}
@media (max-width:640px){.an-g4{grid-template-columns:1fr}.an-leg{grid-template-columns:1fr}.an-kv{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

const COLOUR: Record<string, string> = { us: '#5A27E0', client: '#0ea5e9', other_side: '#f59e0b', lender: '#10b981', searches: '#ec4899', land_registry: '#64748b', other: '#94a3b8', none: '#e2e8f0' };
const pc = (x: number | null | undefined) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const MONTH = (k: string) => new Date(`${k}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const change = (now: number, then: number) => {
  if (!then) return null;
  const c = (now - then) / then;
  return <span className={c >= 0 ? 'an-up' : 'an-down'}>{c >= 0 ? '+' : '−'}{Math.abs(Math.round(c * 100))}%</span>;
};
const hours = (h: number | null) => (h == null ? '–' : h < 24 ? `${Math.round(h)}h` : `${Math.round((h / 24) * 10) / 10}d`);
function S({ s, unit = 'd', p = 'p50' }: { s: Stat; unit?: string; p?: 'p50' | 'p85' }) {
  const v = s[p];
  if (v == null) return <span className="an-thin">–</span>;
  return <span className={s.thin ? 'an-thin' : undefined} title={`Based on ${s.n} case${s.n === 1 ? '' : 's'}${s.thin ? ': too few to rely on' : ''}`}>{unit === 'h' ? hours(v) : `${Math.round(v)}${unit}`}</span>;
}

/** Two years of completions: this year's bars, last year's ticks, the target line; this month's booked completions stacked on top. */
function MonthChart({ r }: { r: AnalyticsReport }) {
  const W = 960, H = 210, PAD = 26, base = H - 30;
  const ms = r.months;
  const max = Math.max(1, ...ms.map((m) => Math.max(m.completions, m.completionsLastYear)), r.pace.forecast, r.pace.target ?? 0) * 1.12;
  const bw = (W - PAD) / ms.length;
  const y = (v: number) => base - (v / max) * (base - 10);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Completions by month, with last year and the target">
      {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1={PAD} x2={W} y1={y(max * f / 1.12)} y2={y(max * f / 1.12)} stroke="#f1f5f9" />)}
      {[0.5, 1].map((f) => <text key={f} x={PAD - 6} y={y(max * f / 1.12) + 4} fontSize="11" textAnchor="end" fill="#94a3b8">{Math.round(max * f / 1.12)}</text>)}
      {ms.map((m, i) => {
        const x = PAD + i * bw + bw * 0.18, w = bw * 0.64;
        const current = i === ms.length - 1;
        return (
          <g key={m.month}>
            <title>{`${MONTH(m.month)}: ${m.completions} completions${current ? `, ${r.pace.booked} booked` : ''}; last year ${m.completionsLastYear}; ${m.instructions} instructions; ${m.fellThrough} fell through`}</title>
            {current && r.pace.booked > 0 && <rect x={x} y={y(m.completions + r.pace.booked)} width={w} height={y(m.completions) - y(m.completions + r.pace.booked)} fill="#c4b5fd" rx="2" />}
            <rect x={x} y={y(m.completions)} width={w} height={base - y(m.completions)} fill="#5A27E0" rx="2" opacity={current ? 1 : 0.85} />
            {m.completionsLastYear > 0 && <line x1={x - 2} x2={x + w + 2} y1={y(m.completionsLastYear)} y2={y(m.completionsLastYear)} stroke="#0f172a" strokeWidth="2" />}
            {(i % 3 === 0 || current || m.month.endsWith('-01')) && <text x={x + w / 2} y={H - 12} fontSize="11" textAnchor="middle" fill="#64748b">{new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}</text>}
            {m.month.endsWith('-01') && <text x={x + w / 2} y={H} fontSize="10" textAnchor="middle" fill="#94a3b8">{m.month.slice(0, 4)}</text>}
          </g>
        );
      })}
      {r.pace.target != null && <g><line x1={PAD} x2={W} y1={y(r.pace.target)} y2={y(r.pace.target)} stroke="#b91c1c" strokeDasharray="5 4" /><rect x={PAD + 4} y={y(r.pace.target) - 17} width="62" height="15" rx="3" fill="#fff" /><text x={PAD + 8} y={y(r.pace.target) - 6} fontSize="11" fill="#b91c1c">Target {r.pace.target}</text></g>}
    </svg>
  );
}

function PeopleTable({ people, onPick }: { people: PersonRow[]; onPick?: (id: string) => void }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="an-t">
        <thead>
          <tr>
            <th>Person</th><th className="num">Active</th><th>This Month</th><th className="num">6-Month Average</th><th className="num">Last 12 Months</th>
            <th className="num">Days To Complete</th><th className="num">Task Turnaround</th><th className="num">Overdue</th><th className="num">With Us</th><th className="num">CSAT</th><th className="num">NPS</th><th className="num">Fall-Through</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => {
            const done = p.completionsThisMonth + p.bookedThisMonth;
            return (
              <tr key={p.id}>
                <td>{onPick ? <button className="an-link" onClick={() => onPick(p.id)}>{p.name}</button> : p.name}</td>
                <td className="num">{p.active}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {p.target ? <span className="an-mini"><i style={{ width: `${Math.min(100, (done / p.target) * 100)}%`, background: done >= p.target ? '#16a34a' : '#5A27E0' }} /></span> : null}
                  {p.completionsThisMonth}{p.bookedThisMonth ? <span className="an-thin"> +{p.bookedThisMonth}</span> : null}{p.target ? <span className="an-thin"> / {p.target}</span> : null}
                </td>
                <td className="num">{p.monthlyAverage6m}</td>
                <td className="num">{p.completions12m}</td>
                <td className="num"><S s={p.cycle} /></td>
                <td className="num"><S s={p.taskHours} unit="h" /></td>
                <td className="num" style={p.overdueTasks ? { color: '#b91c1c', fontWeight: 700 } : undefined}>{p.overdueTasks}</td>
                <td className="num">{pc(p.withUsShare)}</td>
                <td className="num"><span className={p.csat.n < 5 ? 'an-thin' : undefined} title={`${p.csat.n} responses`}>{pc(p.csat.pct)}</span></td>
                <td className="num"><span className={p.nps.n < 5 ? 'an-thin' : undefined} title={`${p.nps.n} responses`}>{p.nps.score ?? '–'}</span></td>
                <td className="num"><span className={p.fallThrough.n < 5 ? 'an-thin' : undefined} title={`${p.fallThrough.n} cases`}>{pc(p.fallThrough.rate)}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AnalyticsView(props: {
  report: AnalyticsReport;
  people: Array<{ id: string; name: string }>;
  person: string;
  side: string;
  admin: boolean;
  onScope: (person: string, side: string) => void;
  caseHref: (id: string) => string | null;
}) {
  const { report: r, person, side } = props;
  const p = r.pace;
  const toTarget = p.target ? Math.min(100, (p.forecast / p.target) * 100) : null;
  const flowOut = useMemo(() => r.flow.shares.filter((s) => s.party !== 'none'), [r.flow.shares]);
  const delayMax = Math.max(0.0001, ...r.delays.map((d) => d.share));
  return (
    <div className="an">
      <style>{CSS}</style>
      <div className="an-top">
        <h1>Analytics</h1>
        <select className="an-sel" value={person} onChange={(e) => props.onScope(e.target.value, side)} aria-label="Whose figures">
          <option value="">Whole Firm</option>
          {props.people.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <select className="an-sel" value={side} onChange={(e) => props.onScope(person, e.target.value)} aria-label="Which cases">
          <option value="">All Cases</option>
          <option value="purchase">Purchases</option>
          <option value="sale">Sales</option>
          <option value="remortgage">Remortgages</option>
          <option value="transfer">Transfers</option>
        </select>
      </div>

      {r.insights.length > 0 && (
        <div className="an-card" style={{ marginBottom: 14 }}>
          <div className="an-h">Read First</div>
          <ul className="an-ins">{r.insights.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}

      <div className="an-grid an-g4">
        <div className="an-card">
          <div className="an-h">Completions This Month</div>
          <div className="an-big">{p.completions}<small>done</small> {p.booked > 0 && <>+{p.booked}<small>booked</small></>}</div>
          {toTarget !== null && <div className="an-bar" title={`Forecast ${p.forecast} of ${p.target}`}><i style={{ width: `${toTarget}%`, background: p.forecast >= (p.target ?? 0) ? '#16a34a' : '#5A27E0' }} /></div>}
          <div className="an-sub">
            {p.target != null ? <>Forecast <b>{p.forecast}</b> of <b>{p.target}</b></> : <>Forecast <b>{p.forecast}</b></>}
            {p.runRate != null && <> · Run rate <b>{p.runRate}</b></>}
            <br />Same point last year <b>{p.samePointLastYear}</b> (month {p.lastYearMonth})
            {p.record && <><br />Record <b>{p.record.completions}</b> in {MONTH(p.record.month)}</>}
          </div>
        </div>
        <div className="an-card">
          <div className="an-h">Instructions</div>
          <div className="an-big">{r.instructions.last4Weeks}<small>last 4 weeks</small></div>
          <div className="an-sub">Same 4 weeks last year <b>{r.instructions.same4WeeksLastYear}</b> {change(r.instructions.last4Weeks, r.instructions.same4WeeksLastYear)}<br />This month <b>{r.instructions.thisMonth}</b> · Year to date completions <b>{p.yearToDate}</b> {change(p.yearToDate, p.lastYearToDate)}</div>
        </div>
        <div className="an-card">
          <div className="an-h">Instruction To Completion</div>
          <div className="an-big"><S s={r.cycle.instructionToCompletion} unit="" /><small>days median</small></div>
          <div className="an-sub">
            85% within <b><S s={r.cycle.instructionToCompletion} unit="" p="p85" /></b> days · Last year <b><S s={r.cycle.lastYearInstructionToCompletion} unit="" /></b>
            <br />To exchange <b><S s={r.cycle.instructionToExchange} unit="" /></b> · Exchange to completion <b><S s={r.cycle.exchangeToCompletion} unit="" /></b>
            <br />Industry <b>{r.cycle.industry.value}</b> ({r.cycle.industry.source})
          </div>
        </div>
        <div className="an-card">
          <div className="an-h">Client Satisfaction</div>
          <div className="an-big">{pc(r.satisfaction.csat.pct)}<small>satisfied</small></div>
          <div className="an-sub">
            NPS <b>{r.satisfaction.nps.score ?? '–'}</b> ({r.satisfaction.nps.n} {r.satisfaction.nps.n === 1 ? 'response' : 'responses'}) · CSAT from {r.satisfaction.csat.n}
            <br />Asked at completion, answered by <b>{pc(r.satisfaction.responseRate)}</b>
          </div>
        </div>
      </div>

      <div className="an-card" style={{ marginBottom: 14 }}>
        <div className="an-h">Completions By Month<span className="r">Bars this year · black ticks last year · light this month's booked</span></div>
        <MonthChart r={r} />
      </div>

      <div className="an-grid an-g2">
        <div className="an-card">
          <div className="an-h">Where Cases Wait<span className="r">Last {r.flow.windowDays} days · {r.flow.caseDays.toLocaleString('en-GB')} case-days</span></div>
          <div className="an-stack">{r.flow.shares.map((s) => <div key={s.party} title={`${s.label}: ${pc(s.share)}`} style={{ width: `${s.share * 100}%`, background: COLOUR[s.party] }} />)}</div>
          <div className="an-leg">{r.flow.shares.map((s) => <div key={s.party}><i style={{ background: COLOUR[s.party] }} />{s.label}<span>{pc(s.share)}</span></div>)}</div>
          {r.flow.withUsOfOutstanding !== null && flowOut.length > 0 && <div className="an-sub" style={{ marginTop: 10 }}>When something is outstanding, it is with us <b>{pc(r.flow.withUsOfOutstanding)}</b> of the time.</div>}
        </div>
        <div className="an-card">
          <div className="an-h">What Cases Wait For<span className="r">Last 12 months</span></div>
          <table className="an-t">
            <thead><tr><th>Waiting For</th><th>Share Of Waiting</th><th className="num">Median</th><th className="num">Open Now</th></tr></thead>
            <tbody>
              {r.delays.slice(0, 8).map((d) => (
                <tr key={d.key}>
                  <td><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: COLOUR[d.party], marginRight: 8 }} />{d.label}</td>
                  <td><span className="an-mini" style={{ width: 90 }}><i style={{ width: `${(d.share / delayMax) * 100}%`, background: COLOUR[d.party] }} /></span>{pc(d.share)}</td>
                  <td className="num"><span className={d.n < 5 ? 'an-thin' : undefined} title={`${d.n} finished`}>{d.p50 == null ? '–' : `${d.p50}d`}</span></td>
                  <td className="num">{d.open}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="an-grid an-g2">
        <div className="an-card">
          <div className="an-h">Our Turnaround<span className="r">Tasks finished in the last 90 days</span></div>
          <div className="an-kv">
            <div><b><S s={r.tasks.turnaroundHours} unit="h" /></b><span>Median</span></div>
            <div><b><S s={r.tasks.turnaroundHours} unit="h" p="p85" /></b><span>85% Within</span></div>
            <div><b style={r.tasks.overdue ? { color: '#b91c1c' } : undefined}>{r.tasks.overdue}</b><span>Over 2 Working Days ({r.tasks.pending} waiting)</span></div>
          </div>
          {r.tasks.slowestKinds.length > 0 && (
            <table className="an-t" style={{ marginTop: 12 }}>
              <thead><tr><th>Slowest To Clear</th><th className="num">Median</th><th className="num">Tasks</th></tr></thead>
              <tbody>{r.tasks.slowestKinds.map((k) => <tr key={k.kind}><td>{k.label}</td><td className="num">{hours(k.p50)}</td><td className="num">{k.n}</td></tr>)}</tbody>
            </table>
          )}
        </div>
        <div className="an-card">
          <div className="an-h">Pipeline And Fall-Through</div>
          <div className="an-kv">
            {r.pipeline.byStep.map((s) => <div key={s.step}><b>{s.count}</b><span>{s.label}</span></div>)}
            <div><b>{r.pipeline.completingNext30}</b><span>Completing In 30 Days</span></div>
          </div>
          <div className="an-sub">Chases answered within 3 days <b>{pc(r.chases.answeredWithin3Days)}</b> of {r.chases.sent}{r.chases.medianDaysToReply != null && <> · median reply <b>{r.chases.medianDaysToReply}</b> days after a chase</>}</div>
          <div className="an-sub" style={{ marginTop: 10 }}>
            Fell through <b>{pc(r.fallThrough.rate)}</b> of {r.fallThrough.n} in the last 12 months (industry {pc(r.fallThrough.industry.value)})
            {r.fallThrough.reasons.length > 0 && <><br />{r.fallThrough.reasons.slice(0, 4).map((x) => `${x.reason} ${x.count}`).join(' · ')}</>}
          </div>
        </div>
      </div>

      {r.ageing.cases.length > 0 && (
        <div className="an-card" style={{ marginBottom: 14 }}>
          <div className="an-h">Cases To Look At<span className="r">{r.ageing.overSle} open longer than {r.cycle.sle ? `85% of cases took (${r.cycle.sle} days)` : 'usual'}</span></div>
          <table className="an-t">
            <thead><tr><th>Case</th><th>Handler</th><th className="num">Days Open</th><th>Stage</th><th>Waiting On</th></tr></thead>
            <tbody>
              {r.ageing.cases.map((c) => {
                const href = props.caseHref(c.id);
                return <tr key={c.id}><td>{href ? <a href={href}>{c.ref}</a> : c.ref}</td><td>{c.handler ?? '–'}</td><td className="num">{c.ageDays}</td><td>{c.step}</td><td>{c.waitingOn}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      )}

      {r.people.length > 0 && (
        <div className="an-card" style={{ marginBottom: 14 }}>
          <div className="an-h">{props.admin && !person ? 'People' : 'Your Figures'}<span className="r">Grey: too few cases to rely on</span></div>
          <PeopleTable people={r.people} onPick={props.admin && !person ? (id) => props.onScope(id, side) : undefined} />
        </div>
      )}

      {r.satisfaction.comments.length > 0 && (
        <div className="an-card">
          <div className="an-h">What Clients Said</div>
          <div className="an-grid an-g2" style={{ marginBottom: 0 }}>
            {r.satisfaction.comments.map((c, i) => <p key={i} className="an-q">{c.comment}<small>{c.kind === 'nps' ? `${c.score}/10 at completion` : `${c.score}/5 at exchange`} · {new Date(c.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</small></p>)}
          </div>
        </div>
      )}
    </div>
  );
}
