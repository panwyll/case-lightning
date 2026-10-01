'use client';
/**
 * The firm's analytics page (lib/server/analytics/kpis.ts, docs/analytics.md). It starts with what to
 * read first, then this month's pace, the two-year trend, where cases wait, our own turnaround, the cases to
 * look at, and each person against their own target and past (listed by name, not ranked).
 */
import { useMemo, useState } from 'react';
import type { AnalyticsReport, PersonRow, Stat, TeamMetric } from '@/lib/server/analytics/kpis';

const CSS = `
.an{max-width:1360px;color:#0f172a}
.an-top{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.an-top h1{font-size:20px;font-weight:800;margin:0 auto 0 0}
.an-sel{border:1px solid #cbd5e1;border-radius:8px;padding:7px 36px 7px 10px;font:inherit;font-size:13px;background:#fff}
.an-card{background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:16px 18px;min-width:0}
.an-h{font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#64748b;margin:0 0 10px;display:flex;align-items:center;gap:8px}
.an-grid{display:grid;gap:14px;margin-bottom:14px}
.an-g4{grid-template-columns:repeat(4,minmax(0,1fr))}
.an-g5{grid-template-columns:repeat(5,minmax(0,1fr))}
.an-g2{grid-template-columns:repeat(2,minmax(0,1fr))}
.an-g3{grid-template-columns:2fr 1fr}
.an-big{font-size:30px;font-weight:800;line-height:1.1;letter-spacing:-.01em}
.an-big small{font-size:14px;font-weight:700;color:#7c3aed;margin-left:8px;letter-spacing:0}
.an-up{color:#15803d;font-weight:700}.an-down{color:#b91c1c;font-weight:700}
.an-bar{position:relative;height:10px;background:#f1f5f9;border-radius:99px;margin-top:10px;overflow:visible}
.an-bar i{position:absolute;top:0;bottom:0;left:0;border-radius:99px}
.an-bar .t{position:absolute;top:-4px;bottom:-4px;width:2px;background:#0f172a;margin-left:-1px}
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
.an-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(58px,1fr));gap:8px;margin-top:12px}
.an-kv b{display:block;font-size:14px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}
.an-kv small{display:block;font-size:11.5px;color:#64748b;margin-top:1px}
.an-kv.big{margin-top:0}
.an-kv.big b{font-size:22px}
.an-chip{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:700;font-size:11.5px;color:#475569;background:#f1f5f9;border-radius:99px;padding:2px 9px}
.an-delta{font-size:13px;margin-left:10px;letter-spacing:0;vertical-align:middle}
.an-of{font-size:12px;color:#94a3b8;font-weight:600}
.an-legend{margin-left:auto;display:flex;align-items:center;gap:6px;text-transform:none;letter-spacing:0;font-weight:600;font-size:11.5px;color:#64748b}
.an-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-left:8px}
.an-set{display:inline-flex;margin-top:6px;background:#5A27E0;color:#fff;border-radius:8px;padding:8px 14px;font-weight:700;font-size:13px;text-decoration:none}
.an-seg{display:inline-flex;background:#f1f5f9;border-radius:8px;padding:2px;text-transform:none;letter-spacing:0;margin-left:8px}
.an-seg button{border:0;background:none;font:inherit;font-size:12px;font-weight:700;color:#64748b;padding:4px 10px;border-radius:6px;cursor:pointer}
.an-seg button.on{background:#fff;color:#0f172a;box-shadow:0 1px 2px rgba(15,23,42,.08)}
.an-people{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px;font-size:12.5px}
.an-people button,.an-people span{display:inline-flex;align-items:center;gap:6px;border:0;background:none;font:inherit;color:#334155;cursor:pointer;padding:2px 0}
.an-people span{cursor:default;color:#64748b}
.an-people button.off{opacity:.35}
.an-people i{width:10px;height:10px;border-radius:3px;display:inline-block}
.an-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.an-chips span{font-size:12px;background:#f8fafc;border:1px solid #e6e8ee;border-radius:99px;padding:2px 9px;color:#475569}
.an-q{font-size:13.5px;line-height:1.5;border-left:3px solid #e2e8f0;padding:2px 0 2px 10px;margin:0 0 10px}
.an-q small{display:block;color:#94a3b8;font-size:12px}
@media (max-width:1250px){.an-g5{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:1100px){.an-g4,.an-g5{grid-template-columns:repeat(2,minmax(0,1fr))}.an-g3,.an-g2{grid-template-columns:1fr}}
@media (max-width:640px){.an-g4,.an-g5{grid-template-columns:1fr}.an-leg{grid-template-columns:1fr}.an-kv{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

const COLOUR: Record<string, string> = { us: '#5A27E0', client: '#0ea5e9', other_side: '#f59e0b', lender: '#10b981', searches: '#ec4899', land_registry: '#64748b', other: '#94a3b8', none: '#e2e8f0' };
const pc = (x: number | null | undefined) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const MONTH = (k: string) => new Date(`${k}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
/** Change on the comparison; `lowerIsBetter` for days. */
const change = (now: number, then: number, lowerIsBetter = false) => {
  if (!then) return null;
  const c = (now - then) / then;
  if (Math.round(c * 100) === 0) return null;
  const good = lowerIsBetter ? c < 0 : c > 0;
  return <span className={`an-delta ${good ? 'an-up' : 'an-down'}`} title="Against the same period last year">{c >= 0 ? '▲' : '▼'} {Math.abs(Math.round(c * 100))}%</span>;
};
const Chip = ({ children }: { children: React.ReactNode }) => <span className="an-chip">{children}</span>;
/** Small label/value pairs under a headline figure. */
function KV({ items, big }: { items: Array<[string, React.ReactNode]>; big?: boolean }) {
  return <div className={`an-kv${big ? ' big' : ''}`}>{items.map(([k, v]) => <div key={k}><b>{v}</b><small>{k}</small></div>)}</div>;
}
/** A bar to a value, with an optional marker (the target, the industry figure). */
function Meter({ value, max, mark, markLabel, good }: { value: number; max: number; mark?: number; markLabel?: string; good: boolean }) {
  return (
    <div className="an-bar">
      <i style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: good ? '#16a34a' : '#5A27E0' }} />
      {mark != null && <span className="t" style={{ left: `${Math.min(100, (mark / max) * 100)}%` }} title={markLabel ?? `Target ${mark}`} />}
    </div>
  );
}
/** Days to exchange and on to completion as one bar, with the industry's total marked. */
function Split({ ex, done, industry, industrySource }: { ex: number | null; done: number | null; industry: number; industrySource: string }) {
  if (ex == null || done == null) return null;
  const max = Math.max(ex + done, industry) * 1.05;
  return (
    <div className="an-bar" style={{ display: 'flex', overflow: 'visible' }}>
      <i style={{ position: 'static', width: `${(ex / max) * 100}%`, background: '#5A27E0', borderRadius: '99px 0 0 99px' }} title={`To exchange: ${Math.round(ex)} days`} />
      <i style={{ position: 'static', width: `${(done / max) * 100}%`, background: '#a78bfa', borderRadius: '0 99px 99px 0' }} title={`Exchange to completion: ${Math.round(done)} days`} />
      <span className="t" style={{ left: `${(industry / max) * 100}%` }} title={`Industry ${industry} days (${industrySource})`} />
    </div>
  );
}
const gbp = (n: number | null | undefined) => (n == null ? '–' : n >= 100_000 ? `£${Math.round(n / 1000)}k` : `£${n.toLocaleString('en-GB')}`);
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
            <title>{`${MONTH(m.month)}: ${m.completions} completions${m.fees ? ` (£${m.fees.toLocaleString('en-GB')})` : ''}${current ? `, ${r.pace.booked} booked` : ''}; last year ${m.completionsLastYear}; ${m.instructions} instructions; ${m.fellThrough} fell through`}</title>
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

const PERSON_COLOURS = ['#5A27E0', '#0ea5e9', '#f59e0b', '#10b981', '#ec4899', '#64748b', '#a855f7', '#14b8a6', '#ef4444', '#84cc16'];
const METRICS: Array<[TeamMetric, string, string]> = [['completions', 'Completions', 'Team Total'], ['instructions', 'Instructions', 'Team Total'], ['responseHours', 'Response Time', 'Team Median'], ['satisfaction', 'Satisfaction', 'Team'], ['surveys', 'Surveys', 'Team Total'], ['surveyRate', 'Survey Rate', 'Team']];

/** Each person's bars month by month, clustered, with the team's line over them (on its own scale when it is a total). */
function TeamChart({ team }: { team: AnalyticsReport['team'] }) {
  const [metric, setMetric] = useState<TeamMetric>('completions');
  const [span, setSpan] = useState<6 | 12>(6);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const m = team.metrics[metric];
  const from = team.months.length - span;
  const months = team.months.slice(from);
  const shown = team.people.map((p, i) => ({ ...p, i, colour: PERSON_COLOURS[i % PERSON_COLOURS.length] })).filter((p) => !hidden.has(p.id));
  const vals = shown.map((p) => m.perPerson[p.i].slice(from));
  const line = m.team.slice(from);
  const W = 960, H = 250, L = 34, R = m.kind === 'count' ? 40 : 10, base = H - 34;
  const fmt = (v: number) => (m.kind === 'hours' ? hours(v) : m.kind === 'percent' ? `${v}%` : String(v));
  const leftMax = Math.max(1, ...vals.flat().filter((v): v is number => v != null), ...(m.kind === 'count' ? [] : line.filter((v): v is number => v != null))) * 1.15;
  const rightMax = m.kind === 'count' ? Math.max(1, ...line.filter((v): v is number => v != null)) * 1.15 : leftMax;
  const yL = (v: number) => base - (v / leftMax) * (base - 12);
  const yR = (v: number) => base - (v / rightMax) * (base - 12);
  const cw = (W - L - R) / months.length;
  const bw = Math.min(26, (cw * 0.78) / Math.max(1, shown.length));
  const cx = (j: number) => L + j * cw + cw / 2;
  const pts = line.map((v, j) => (v == null ? null : [cx(j), yR(v)] as const));
  const path = pts.reduce((acc, p, j) => (p ? `${acc}${acc && pts[j - 1] ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}` : acc), '');
  return (
    <div className="an-card" style={{ marginBottom: 14 }}>
      <div className="an-h">Team
        <span className="an-seg" style={{ marginLeft: 'auto' }}>{METRICS.map(([k, label]) => <button key={k} className={metric === k ? 'on' : ''} onClick={() => setMetric(k)}>{label}</button>)}</span>
        <span className="an-seg">{([6, 12] as const).map((n) => <button key={n} className={span === n ? 'on' : ''} onClick={() => setSpan(n)}>{n} Months</button>)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${METRICS.find((x) => x[0] === metric)![1]} by person and month`}>
        {[0.5, 1].map((f) => <g key={f}><line x1={L} x2={W - R} y1={yL((leftMax / 1.15) * f)} y2={yL((leftMax / 1.15) * f)} stroke="#f1f5f9" /><text x={L - 6} y={yL((leftMax / 1.15) * f) + 4} fontSize="11" textAnchor="end" fill="#94a3b8">{fmt(Math.round((leftMax / 1.15) * f))}</text></g>)}
        {m.kind === 'count' && [0.5, 1].map((f) => <text key={f} x={W - R + 6} y={yR((rightMax / 1.15) * f) + 4} fontSize="11" fill="#0f172a">{Math.round((rightMax / 1.15) * f)}</text>)}
        {months.map((mo, j) => (
          <g key={mo}>
            {shown.map((p, k) => {
              const v = vals[k][j];
              if (v == null || v === 0) return null;
              const x = cx(j) - (shown.length * bw) / 2 + k * bw;
              return <rect key={p.id} x={x + 1} y={yL(v)} width={bw - 2} height={base - yL(v)} rx="2" fill={p.colour}><title>{`${p.name}, ${MONTH(mo)}: ${fmt(v)}`}</title></rect>;
            })}
            <text x={cx(j)} y={H - 14} fontSize="11" textAnchor="middle" fill="#64748b">{new Date(`${mo}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}</text>
          </g>
        ))}
        {path && <path d={path} fill="none" stroke="#0f172a" strokeWidth="2" />}
        {pts.map((p, j) => p && <circle key={j} cx={p[0]} cy={p[1]} r="3.5" fill="#fff" stroke="#0f172a" strokeWidth="2"><title>{`${METRICS.find((x) => x[0] === metric)![2]}, ${MONTH(months[j])}: ${fmt(line[j]!)}`}</title></circle>)}
      </svg>
      <div className="an-people">
        {team.people.map((p, i) => (
          <button key={p.id} className={hidden.has(p.id) ? 'off' : ''} onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })}>
            <i style={{ background: PERSON_COLOURS[i % PERSON_COLOURS.length] }} />{p.name}
          </button>
        ))}
        <span><i style={{ background: '#0f172a', height: 2, borderRadius: 0 }} />{METRICS.find((x) => x[0] === metric)![2]}</span>
      </div>
    </div>
  );
}

function PeopleTable({ people, onPick, fees }: { people: PersonRow[]; onPick?: (id: string) => void; fees: boolean }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="an-t">
        <thead>
          <tr>
            <th>Person</th><th className="num">Active</th><th>This Month</th><th className="num">6-Month Average</th><th className="num">Last 12 Months</th>{fees && <th className="num">Fees 12 Months</th>}
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
                {fees && <td className="num">{gbp(p.fees12m)}</td>}
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
  /** Where an admin sets the firm's fees, while none are set. */
  feesHref?: string | null;
}) {
  const { report: r, person, side } = props;
  const p = r.pace;
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

      <div className="an-grid an-g5">
        <div className="an-card">
          <div className="an-h">Completions This Month</div>
          <div className="an-big">{p.completions}{p.booked > 0 && <small>+{p.booked} Booked</small>}</div>
          {p.target != null && <Meter value={p.forecast} max={Math.max(p.target, p.forecast)} mark={p.target} good={p.forecast >= p.target} />}
          <KV items={[['Target', p.target ?? '–'], ['Last Year', p.lastYearMonth], ['Record', p.record ? <span title={MONTH(p.record.month)}>{p.record.completions}</span> : '–']]} />
        </div>
        <div className="an-card">
          <div className="an-h">Fee Income This Month</div>
          {r.fees.set ? (
            <>
              <div className="an-big">{gbp(r.fees.thisMonth)}{r.fees.booked > 0 && <small>+{gbp(r.fees.booked)} Booked</small>}</div>
              {r.fees.lastYearMonth > 0 && <Meter value={r.fees.forecast} max={Math.max(r.fees.forecast, r.fees.lastYearMonth)} mark={r.fees.lastYearMonth} markLabel={`Last year ${gbp(r.fees.lastYearMonth)}`} good={r.fees.forecast >= r.fees.lastYearMonth} />}
              <KV items={[['Year To Date', <span key="y" title={`Last year to date ${gbp(r.fees.lastYearToDate)}`}>{gbp(r.fees.yearToDate)}</span>], ['Per Case', gbp(r.fees.perCompletion)], ['In Pipeline', gbp(r.fees.pipeline)]]} />
            </>
          ) : props.feesHref ? <a className="an-set" href={props.feesHref}>Set Your Fees</a> : <div className="an-big an-thin">–</div>}
        </div>
        <div className="an-card">
          <div className="an-h">Instructions<Chip>4 Weeks</Chip></div>
          <div className="an-big">{r.instructions.last4Weeks}{change(r.instructions.last4Weeks, r.instructions.same4WeeksLastYear)}</div>
          <KV items={[['Last Year', r.instructions.same4WeeksLastYear], ['This Month', r.instructions.thisMonth], ['Completions YTD', <span key="c" title={`Last year to date ${p.lastYearToDate}`}>{p.yearToDate}</span>]]} />
        </div>
        <div className="an-card">
          <div className="an-h">Days To Complete</div>
          <div className="an-big"><S s={r.cycle.instructionToCompletion} unit="" />{r.cycle.lastYearInstructionToCompletion.p50 != null && r.cycle.instructionToCompletion.p50 != null && change(r.cycle.instructionToCompletion.p50, r.cycle.lastYearInstructionToCompletion.p50, true)}</div>
          <Split ex={r.cycle.instructionToExchange.p50} done={r.cycle.exchangeToCompletion.p50} industry={r.cycle.industry.value} industrySource={r.cycle.industry.source} />
          <KV items={[['85% Within', <S key="p" s={r.cycle.instructionToCompletion} unit="" p="p85" />], ['Last Year', <S key="l" s={r.cycle.lastYearInstructionToCompletion} unit="" />], ['Industry', <span key="i" title={r.cycle.industry.source}>{r.cycle.industry.value}</span>]]} />
        </div>
        <div className="an-card">
          <div className="an-h">Client Satisfaction</div>
          <div className="an-big"><span className={r.satisfaction.csat.n < 5 ? 'an-thin' : undefined}>{pc(r.satisfaction.csat.pct)}</span></div>
          {r.satisfaction.csat.pct != null && <Meter value={r.satisfaction.csat.pct} max={1} good={r.satisfaction.csat.pct >= 0.8} />}
          <KV items={[['NPS', <span key="n" className={r.satisfaction.nps.n < 5 ? 'an-thin' : undefined}>{r.satisfaction.nps.score ?? '–'}</span>], ['Responses', r.satisfaction.csat.n + r.satisfaction.nps.n], ['Response Rate', pc(r.satisfaction.responseRate)]]} />
        </div>
      </div>

      <div className="an-card" style={{ marginBottom: 14 }}>
        <div className="an-h">Completions By Month
          <span className="an-legend"><i style={{ background: '#5A27E0' }} />This Year<i style={{ background: '#0f172a', height: 2 }} />Last Year<i style={{ background: '#c4b5fd' }} />Booked{p.target != null && <><i style={{ background: 'none', borderTop: '2px dashed #b91c1c', height: 0 }} />Target</>}</span>
        </div>
        <MonthChart r={r} />
      </div>

      <div className="an-grid an-g2">
        <div className="an-card">
          <div className="an-h">Where Cases Wait<Chip>90 Days</Chip></div>
          <div className="an-stack">{r.flow.shares.map((s) => <div key={s.party} title={`${s.label}: ${pc(s.share)}`} style={{ width: `${s.share * 100}%`, background: COLOUR[s.party] }} />)}</div>
          <div className="an-leg">{r.flow.shares.map((s) => <div key={s.party} style={s.party === 'us' ? { fontWeight: 700 } : undefined}><i style={{ background: COLOUR[s.party] }} />{s.label}<span>{pc(s.share)}</span></div>)}</div>
          {r.flow.withUsOfOutstanding !== null && flowOut.length > 0 && <KV items={[['With Us When Open', pc(r.flow.withUsOfOutstanding)], ['Case-Days', r.flow.caseDays.toLocaleString('en-GB')]]} />}
        </div>
        <div className="an-card">
          <div className="an-h">What Cases Wait For<Chip>12 Months</Chip></div>
          <table className="an-t">
            <thead><tr><th>Waiting For</th><th>Share</th><th className="num">Median</th><th className="num">Open</th></tr></thead>
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
          <div className="an-h">Our Turnaround<Chip>90 Days</Chip></div>
          <KV big items={[['Median', <S key="m" s={r.tasks.turnaroundHours} unit="h" />], ['85% Within', <S key="p" s={r.tasks.turnaroundHours} unit="h" p="p85" />], ['Waiting', r.tasks.pending], ['Overdue', <span key="o" style={r.tasks.overdue ? { color: '#b91c1c' } : undefined}>{r.tasks.overdue}</span>]]} />
          {r.tasks.slowestKinds.length > 0 && (
            <table className="an-t" style={{ marginTop: 10 }}>
              <thead><tr><th>Slowest To Clear</th><th className="num">Median</th><th className="num">Tasks</th></tr></thead>
              <tbody>{r.tasks.slowestKinds.map((k) => <tr key={k.kind}><td>{k.label}</td><td className="num">{hours(k.p50)}</td><td className="num">{k.n}</td></tr>)}</tbody>
            </table>
          )}
        </div>
        <div className="an-card">
          <div className="an-h">Pipeline</div>
          <KV big items={[...r.pipeline.byStep.map((x) => [x.label, x.count] as [string, React.ReactNode]), ['Completing In 30 Days', r.pipeline.completingNext30]]} />
          <div className="an-h" style={{ marginTop: 16 }}>Fell Through<Chip>12 Months</Chip></div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}><span className="an-big" style={{ fontSize: 24 }}><span className={r.fallThrough.n < 5 ? 'an-thin' : undefined}>{pc(r.fallThrough.rate)}</span></span><span className="an-of">of {r.fallThrough.n}</span></div>
          {r.fallThrough.rate != null && <Meter value={r.fallThrough.rate} max={Math.max(0.4, r.fallThrough.rate)} mark={r.fallThrough.industry.value} markLabel={`Industry ${pc(r.fallThrough.industry.value)}`} good={r.fallThrough.rate <= r.fallThrough.industry.value} />}
          {r.fallThrough.reasons.length > 0 && <div className="an-chips">{r.fallThrough.reasons.slice(0, 5).map((x) => <span key={x.reason}>{x.reason} <b>{x.count}</b></span>)}</div>}
          <div className="an-h" style={{ marginTop: 16 }}>Chases<Chip>90 Days</Chip></div>
          <KV items={[['Sent', r.chases.sent], ['Answered In 3 Days', pc(r.chases.answeredWithin3Days)], ['Median Reply', r.chases.medianDaysToReply == null ? '–' : `${r.chases.medianDaysToReply}d`]]} />
        </div>
      </div>

      {r.ageing.cases.length > 0 && (
        <div className="an-card" style={{ marginBottom: 14 }}>
          <div className="an-h">Cases To Look At<Chip>{r.ageing.overSle} Over {r.cycle.sle ?? Math.round(r.cycle.industry.value * 1.3)} Days</Chip></div>
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

      {r.team.people.length > 0 && <TeamChart team={r.team} />}

      {r.people.length > 0 && (
        <div className="an-card" style={{ marginBottom: 14 }}>
          <div className="an-h">{props.admin && !person ? 'People' : 'Your Figures'}</div>
          <PeopleTable fees={r.fees.set} people={r.people} onPick={props.admin && !person ? (id) => props.onScope(id, side) : undefined} />
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
