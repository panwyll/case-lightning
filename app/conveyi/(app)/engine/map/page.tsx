'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { STAGE_LABEL, type IssueCatalogue } from '@/app/shared/engine/types';

/**
 * The state machine, drawn from code. Read-only. Everything on this page comes from
 * GET /api/v1/engine/spec, which is built from the machine's own tables and checked
 * against its behaviour by tests — so what you see is what runs.
 */
interface Spec {
  version: string;
  generatedFrom: string;
  transactionTypes: Array<{ type: string; label: string; side: string; tenure: string; hasExchange: boolean; stages: string[]; stageLabels: Record<string, string>; stageGates: Record<string, string[]>; workstreams: string[]; subflows: string[]; defaultSearches: string[]; counterparty: string; fundsFrom: string[]; registration: string; note: string }>;
  stages: Array<{ id: string; label: string; purpose: string; gates: string[]; subflows: string[]; typical: string[] }>;
  terminal: Array<{ id: string; label: string; how: string }>;
  subflows: Array<{ id: string; label: string; stage: string; waitKey: string | null; start: string[]; extracted: string | null; cleared: string | null; flagged: string | null; reviewed: string | null; decisionKind: string | null; rule: string }>;
  commands: Array<{ type: string; actor: string; stages: string[] | 'any' | 'not_enrolled'; emits: string[]; description: string; eventuality?: boolean; humanGated?: boolean; hardStop?: boolean; types?: string[] }>;
  events: Array<{ type: string; category: string; decision: boolean; humanGated: boolean }>;
  decisions: Array<{ kind: string; label: string; options: string[]; source: string }>;
  timers: { waits: Array<{ waitKey: string; chaseAfter: number; chaseEvery: number | null; escalateAfter: number; reEscalateAfter: number; recipientRole: string; template: string }>; deadlines: Array<{ kind: string; leadWorkingDays: number; description: string }> };
  thresholds: { extractionConfidence: number; classificationConfidence: number };
  invariants: Array<{ id: string; title: string; rule: string; enforcedBy: string[] }>;
  triggers: Array<{ id: string; backend: string; source: string; feeds: string; label: string; description: string; entry: string; implemented: boolean; reaches: string[]; notes?: string }>;
  eventualities: Array<{ area: string; scenario: string; handling: string; mechanism: string }>;
  issues: IssueCatalogue;
}

const CSS = `
.mp h2{font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#64748b;margin:28px 0 10px}
.mp figure{margin:0;background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:12px;overflow-x:auto}
.mp figure svg{display:block;min-width:1180px;height:auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.mp figcaption{font-size:12px;color:#64748b;margin-top:8px}
.mp table{border-collapse:collapse;width:100%;font-size:12.5px;background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden}
.mp th,.mp td{text-align:left;padding:7px 10px;border-top:1px solid #f1f5f9;vertical-align:top}
.mp th{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#94a3b8;border-top:0;background:#fafafa}
.mp code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:#f1f5f9;border-radius:4px;padding:1px 4px}
.mp .muted{color:#94a3b8}
.mp .filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.mp .inv{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}
.mp .inv div{background:#fff;border:1px solid #e6e8ee;border-left:3px solid #0f172a;border-radius:10px;padding:10px 12px;font-size:12.5px}
.mp .inv b{display:block;margin-bottom:3px}
`;

const ACTOR: Record<string, string> = { person: 'person', automation: 'automation', either: 'person or automation' };
const HANDLING: Record<string, string> = { built: 'ok', manual: 'pending', outside: 'muted', gap: 'bad' };

export default function MapPage() {
  const [spec, setSpec] = useState<Spec | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [area, setArea] = useState('all');
  const [handling, setHandling] = useState('all');
  const [backend, setBackend] = useState('all');
  const [issueGroup, setIssueGroup] = useState('all');
  const [txType, setTxType] = useState('all');
  useEffect(() => {
    api<Spec>('/engine/spec').then(setSpec).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the spec.'));
  }, []);
  const areas = useMemo(() => Array.from(new Set(spec?.eventualities.map((e) => e.area) ?? [])), [spec]);
  const profile = useMemo(() => spec?.transactionTypes.find((t) => t.type === txType) ?? null, [spec, txType]);
  /** The stage spine as this type passes through it (a remortgage / transfer has no exchange phases). */
  const stagesShown = useMemo(() => (spec ? (profile ? spec.stages.filter((s) => profile.stages.includes(s.id)) : spec.stages) : []), [spec, profile]);
  const commandsShown = useMemo(() => (spec ? spec.commands.filter((c) => !profile || !c.types || c.types.includes(profile.type)) : []), [spec, profile]);

  if (!spec) {
    return (
      <div className="eg" style={{ padding: 24 }}>
        <style>{ENGINE_CSS}</style>
        {err ? <div className="eg-err">{err}</div> : <div className="eg-sub">Loading…</div>}
      </div>
    );
  }
  // ── stage spine geometry ──
  const W = 150, GAP = 22, X0 = 20, Y = 40, H = 54;
  const stageX = (i: number) => X0 + i * (W + GAP);
  const gatesOf = (st: { id: string; gates: string[] }) => profile?.stageGates[st.id] ?? st.gates;
  const subflowsOf = (st: { id: string; subflows: string[] }) => (profile ? st.subflows.filter((sf) => profile.subflows.includes(sf)) : st.subflows);
  const gateLines = stagesShown.map((s) => gatesOf(s).length);
  const label = (id: string) => profile?.stageLabels[id] ?? STAGE_LABEL[id] ?? id;
  const spineH = Y + H + 30 + Math.max(...gateLines) * 15 + 70;

  return (
    <div className="eg mp" style={{ maxWidth: 1240, margin: '0 auto', padding: '20px 16px 60px' }}>
      <style>{ENGINE_CSS + CSS}</style>
      <div className="eg-top">
        <div>
          <h1 className="eg-h1">Machine Map</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a className="eg-btn" href="/conveyi/admin?tab=mywork">Tasks</a>
          <a className="eg-btn" href="/api/v1/engine/spec" target="_blank" rel="noreferrer">JSON</a>
        </div>
      </div>

      <h2>Transaction Types</h2>
      <div className="filters">
        <button className={`eg-btn${txType === 'all' ? ' on' : ''}`} onClick={() => setTxType('all')}>All types</button>
        {spec.transactionTypes.map((t) => <button key={t.type} className={`eg-btn${txType === t.type ? ' on' : ''}`} onClick={() => setTxType(t.type)}>{t.label}</button>)}
      </div>
      <table>
        <thead><tr><th>Type</th><th>Side</th><th>Tenure</th><th>Exchange</th><th>Phases</th><th>Workstreams</th><th>Sub-flows</th><th>Money from</th><th>After completion</th></tr></thead>
        <tbody>
          {spec.transactionTypes.filter((t) => txType === 'all' || t.type === txType).map((t) => (
            <tr key={t.type}>
              <td><b>{t.label}</b></td>
              <td>{t.side}</td>
              <td>{t.tenure}</td>
              <td>{t.hasExchange ? 'yes' : <span className="muted">none</span>}</td>
              <td>{t.stages.map((st) => t.stageLabels[st] ?? STAGE_LABEL[st] ?? st).join(' → ')}</td>
              <td>{t.workstreams.map((w) => w.replace(/_/g, ' ')).join(', ')}</td>
              <td>{t.subflows.join(', ')}</td>
              <td>{t.fundsFrom.map((f) => f.replace(/_/g, ' ')).join(', ')}</td>
              <td>{t.registration === 'ap1' ? 'SDLT / AP1 → registered' : t.registration === 'discharge_only' ? 'redeem → account to client → discharge' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Stages{profile ? ` — ${profile.label}` : ''}</h2>
      <figure>
        <svg viewBox={`0 0 ${X0 * 2 + stagesShown.length * (W + GAP)} ${spineH}`} role="img" aria-label="Eight stages left to right; under each, the gates that must be true to leave it; abandonment and manual handling can leave from any stage.">
          <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#0f172a" /></marker></defs>
          {stagesShown.map((s, i) => (
            <g key={s.id}>
              <rect x={stageX(i)} y={Y} width={W} height={H} rx="10" fill={i === stagesShown.length - 1 ? '#0f172a' : '#fff'} stroke="#0f172a" strokeWidth="1.5" />
              <text x={stageX(i) + W / 2} y={Y + 23} textAnchor="middle" fontSize="12" fontWeight="700" fill={i === stagesShown.length - 1 ? '#fff' : '#0f172a'}>{label(s.id)}</text>
              <text x={stageX(i) + W / 2} y={Y + 41} textAnchor="middle" fontSize="10" fill={i === spec.stages.length - 1 ? '#c7d2fe' : '#64748b'}>{subflowsOf(s).length ? subflowsOf(s).join(' · ') : 'milestones'}</text>
              {i < stagesShown.length - 1 && <line x1={stageX(i) + W} y1={Y + H / 2} x2={stageX(i + 1) - 2} y2={Y + H / 2} stroke="#0f172a" strokeWidth="1.4" markerEnd="url(#arr)" />}
              <text x={stageX(i) + 6} y={Y + H + 22} fontSize="10" fontWeight="800" fill="#94a3b8" letterSpacing=".06em">GATES</text>
              {gatesOf(s).map((g, j) => (
                <foreignObject key={j} x={stageX(i)} y={Y + H + 26 + j * 15} width={W} height={16}>
                  <div style={{ fontSize: 10, lineHeight: '15px', color: '#334155', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={g}>· {g}</div>
                </foreignObject>
              ))}
            </g>
          ))}
          {/* terminal exits */}
          <g>
            <rect x={X0} y={spineH - 58} width={220} height={40} rx="10" fill="#fee2e2" stroke="#b91c1c" />
            <text x={X0 + 110} y={spineH - 41} textAnchor="middle" fontSize="12" fontWeight="700" fill="#7f1d1d">abandoned (any stage)</text>
            <text x={X0 + 110} y={spineH - 26} textAnchor="middle" fontSize="10" fill="#7f1d1d">waits close · timers stop · corrections only</text>
            <rect x={X0 + 240} y={spineH - 58} width={240} height={40} rx="10" fill="#fef3c7" stroke="#b45309" />
            <text x={X0 + 360} y={spineH - 41} textAnchor="middle" fontSize="12" fontWeight="700" fill="#78350f">manual handling (any stage)</text>
            <text x={X0 + 360} y={spineH - 26} textAnchor="middle" fontSize="10" fill="#78350f">automation stops · the log continues</text>
            <rect x={X0 + 500} y={spineH - 58} width={200} height={40} rx="10" fill="#dcfce7" stroke="#15803d" />
            <text x={X0 + 600} y={spineH - 41} textAnchor="middle" fontSize="12" fontWeight="700" fill="#14532d">registered</text>
            <text x={X0 + 600} y={spineH - 26} textAnchor="middle" fontSize="10" fill="#14532d">ap1_confirmed · the last wait closes</text>
          </g>
        </svg>
      </figure>

      <h2>Sub-flows</h2>
      <figure>
        <svg viewBox={`0 0 1180 ${40 + spec.subflows.length * 78}`} role="img" aria-label="Each sub-flow: something arrives, the rule layer clears it or flags it, a flagged item is a decision a person resolves; chasing and escalation sit alongside.">
          <defs><marker id="arr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#64748b" /></marker></defs>
          {spec.subflows.map((sf, i) => {
            const y = 20 + i * 78;
            const box = (x: number, w: number, text: string, fill: string, stroke: string, color = '#0f172a') => (
              <g><rect x={x} y={y} width={w} height={34} rx="8" fill={fill} stroke={stroke} /><text x={x + w / 2} y={y + 21} textAnchor="middle" fontSize="11" fontFamily="ui-monospace, Menlo, monospace" fill={color}>{text}</text></g>
            );
            const arrow = (x1: number, x2: number, dy = 17, label?: string) => (
              <g><line x1={x1} y1={y + dy} x2={x2} y2={y + dy} stroke="#64748b" strokeWidth="1.2" markerEnd="url(#arr2)" />{label && <text x={(x1 + x2) / 2} y={y + dy - 5} textAnchor="middle" fontSize="9" fill="#64748b">{label}</text>}</g>
            );
            const dk = spec.decisions.find((d) => d.kind === sf.decisionKind);
            return (
              <g key={sf.id}>
                <text x={0} y={y + 14} fontSize="12" fontWeight="800" fill="#0f172a">{sf.label}</text>
                <text x={0} y={y + 29} fontSize="10" fill="#94a3b8">{sf.stage}{sf.waitKey ? ` · wait: ${sf.waitKey}` : ''}</text>
                {box(150, 150, sf.start[sf.start.length - 1], '#e2f3ef', '#137a6a')}
                {arrow(300, 340)}
                {sf.cleared ? box(340, 150, sf.cleared, '#e6eef9', '#2f5f9e') : box(340, 150, 'always a decision', '#fff', '#cbd5e1', '#64748b')}
                {sf.flagged && <g>{arrow(300, 340, 17)}<line x1={415} y1={y + 34} x2={415} y2={y + 52} stroke="#64748b" strokeDasharray="3 3" /></g>}
                {sf.flagged && box(520, 190, sf.flagged, '#efe8fb', '#6e42c1')}
                {sf.flagged && arrow(490, 520, 17, sf.cleared ? 'or' : '')}
                {sf.reviewed && arrow(710, 750, 17, 'person')}
                {sf.reviewed && box(750, 190, sf.reviewed, '#fbeedd', '#b8690f')}
                {dk && <foreignObject x={955} y={y - 4} width={225} height={44}><div style={{ fontSize: 10, color: '#475569', lineHeight: '13px' }}>options: {dk.options.join(' · ')}</div></foreignObject>}
              </g>
            );
          })}
        </svg>
      </figure>
      <table>
        <thead><tr><th>Sub-flow</th><th>Rule</th></tr></thead>
        <tbody>{spec.subflows.map((sf) => <tr key={sf.id}><td><b>{sf.label}</b></td><td>{sf.rule}</td></tr>)}</tbody>
      </table>

      <h2>Commands{profile ? ` — ${profile.label}` : ''}</h2>
      <table>
        <thead><tr><th>Command</th><th>Actor</th><th>Accepted at</th><th>Emits</th><th>Meaning</th></tr></thead>
        <tbody>
          {commandsShown.map((c) => (
            <tr key={c.type}>
              <td><code>{c.type}</code>{c.eventuality && <span className="eg-chip info" style={{ marginLeft: 6 }}>eventuality</span>}{c.humanGated && <span className="eg-chip bad" style={{ marginLeft: 6 }}>human gate</span>}{c.hardStop && <span className="eg-chip bad" style={{ marginLeft: 6 }}>hard stop</span>}</td>
              <td><span className={`eg-chip ${c.actor === 'person' ? 'pending' : c.actor === 'automation' ? 'muted' : 'info'}`}>{ACTOR[c.actor]}</span></td>
              <td>{c.stages === 'any' ? <span className="muted">any (enrolled)</span> : c.stages === 'not_enrolled' ? <span className="muted">before enrolment</span> : c.stages.filter((st) => !profile || profile.stages.includes(st)).map((st) => label(st)).join(', ')}{c.types && !profile ? <div className="muted" style={{ fontSize: 11 }}>{c.types.map((t) => spec.transactionTypes.find((x) => x.type === t)?.label ?? t).join(', ')}</div> : null}</td>
              <td>{c.emits.map((e) => <code key={e} style={{ marginRight: 4 }}>{e}</code>)}</td>
              <td>{c.description}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Timers</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(420px,1fr))', gap: 12 }}>
        <table>
          <thead><tr><th>Wait</th><th>Chase after</th><th>Every</th><th>Escalate</th><th>Again after</th><th>Who is chased</th></tr></thead>
          <tbody>{spec.timers.waits.map((w) => <tr key={w.waitKey}><td><b>{w.waitKey.replace(/_/g, ' ')}</b><div className="muted">{w.template}</div></td><td>{w.chaseAfter} wd</td><td>{w.chaseEvery === null ? '—' : `${w.chaseEvery} wd`}</td><td>{w.escalateAfter} wd</td><td>{w.reEscalateAfter} wd</td><td>{w.recipientRole.replace(/_/g, ' ')}</td></tr>)}</tbody>
        </table>
        <table>
          <thead><tr><th>Deadline</th><th>Raised</th><th>What</th></tr></thead>
          <tbody>{spec.timers.deadlines.map((d) => <tr key={d.kind}><td><b>{d.kind.replace(/_/g, ' ')}</b></td><td>{d.leadWorkingDays} wd before</td><td>{d.description}</td></tr>)}</tbody>
        </table>
      </div>

      <h2>Triggers</h2>
      <div className="filters">
        {['all', 'native', 'leap'].map((b) => <button key={b} className={`eg-btn${backend === b ? ' on' : ''}`} onClick={() => setBackend(b)}>{b === 'all' ? 'Both backends' : b === 'native' ? 'Own app (CaseLightning)' : 'LEAP'}</button>)}
      </div>
      <table>
        <thead><tr><th>Trigger</th><th>Backend</th><th>Source</th><th>Feeds</th><th>Reaches</th><th>Where</th></tr></thead>
        <tbody>
          {spec.triggers.filter((t) => backend === 'all' || t.backend === backend || t.backend === 'both').map((t) => (
            <tr key={t.id} style={t.implemented ? undefined : { opacity: 0.6 }}>
              <td><b>{t.label}</b>{!t.implemented && <span className="eg-chip muted" style={{ marginLeft: 6 }}>planned</span>}<div className="muted">{t.description}{t.notes ? ` — ${t.notes}` : ''}</div></td>
              <td><span className={`eg-chip ${t.backend === 'leap' ? 'shadow' : t.backend === 'native' ? 'info' : 'muted'}`}>{t.backend}</span></td>
              <td>{t.source}</td>
              <td>{t.feeds}</td>
              <td>{t.reaches.map((r) => <code key={r} style={{ marginRight: 4 }}>{r}</code>)}</td>
              <td><code>{t.entry}</code></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Eventualities</h2>
      <div className="filters">
        {['all', ...areas].map((a) => <button key={a} className={`eg-btn${area === a ? ' on' : ''}`} onClick={() => setArea(a)}>{a === 'all' ? 'All areas' : a.replace(/_/g, ' ')}</button>)}
        <span style={{ width: 12 }} />
        {['all', 'built', 'manual', 'outside', 'gap'].map((h) => <button key={h} className={`eg-btn${handling === h ? ' on' : ''}`} onClick={() => setHandling(h)}>{h}</button>)}
      </div>
      <table>
        <thead><tr><th>Area</th><th>Scenario</th><th>Handling</th><th>Mechanism</th></tr></thead>
        <tbody>
          {spec.eventualities.filter((e) => (area === 'all' || e.area === area) && (handling === 'all' || e.handling === handling)).map((e, i) => (
            <tr key={i}><td className="muted">{e.area.replace(/_/g, ' ')}</td><td><b>{e.scenario}</b></td><td><span className={`eg-chip ${HANDLING[e.handling]}`}>{e.handling}</span></td><td>{e.mechanism}</td></tr>
          ))}
        </tbody>
      </table>

      <h2>Issues</h2>
      <div className="filters">
        {['all', ...spec.issues.groups.map((g) => g.id)].map((g) => <button key={g} className={`eg-btn${issueGroup === g ? ' on' : ''}`} onClick={() => setIssueGroup(g)}>{g === 'all' ? 'All groups' : spec.issues.groups.find((x) => x.id === g)?.label}</button>)}
      </div>
      <table>
        <thead><tr><th>Kind</th><th>Arises from</th><th>Holds</th><th>Realistic resolutions</th><th>What happens in practice</th></tr></thead>
        <tbody>
          {spec.issues.kinds.filter((k) => issueGroup === 'all' || k.group === issueGroup).map((k) => (
            <tr key={k.kind}>
              <td><b>{k.label}</b><div className="muted"><code>{k.kind}</code></div></td>
              <td>{k.arisesFrom}{k.overlaps ? <div className="muted" style={{ marginTop: 3 }}>Already covered in part: {k.overlaps}</div> : null}</td>
              <td><span className={`eg-chip ${k.gate === 'none' ? 'muted' : 'pending'}`}>{k.gate === 'none' ? 'nothing' : k.gate}</span></td>
              <td>{k.resolutions.map((r) => spec.issues.resolutions.find((x) => x.id === r)?.label ?? r).join(' · ')}</td>
              <td>{k.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table style={{ marginTop: 10 }}>
        <thead><tr><th>Resolution</th><th>Effect on the rest of the machine</th></tr></thead>
        <tbody>{spec.issues.resolutions.filter((r) => r.effects.length).map((r) => <tr key={r.id}><td><b>{r.label}</b> <code>{r.id}</code></td><td>{r.effects.join('; ')}</td></tr>)}</tbody>
      </table>

      <h2>Invariants</h2>
      <div className="inv">{spec.invariants.map((v) => <div key={v.id}><b>{v.title}</b>{v.rule}<div className="muted" style={{ marginTop: 4 }}>{v.enforcedBy.join(' · ')}</div></div>)}</div>

      <h2>Decision Kinds</h2>
      <table>
        <thead><tr><th>Kind</th><th>Options</th><th>Its source</th></tr></thead>
        <tbody>{spec.decisions.map((d) => <tr key={d.kind}><td><b>{d.label}</b></td><td>{d.options.join(' · ')}</td><td>{d.source}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
