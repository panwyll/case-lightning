'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../shared/engine/api';
import { ENGINE_CSS } from '../../shared/engine/ui';
import { STAGE_LABEL } from '../../shared/engine/types';

/**
 * The state machine, drawn from code. Read-only. Everything on this page comes from
 * GET /api/v1/engine/spec, which is built from the machine's own tables and checked
 * against its behaviour by tests — so what you see is what runs.
 */
interface Spec {
  version: string;
  generatedFrom: string;
  stages: Array<{ id: string; label: string; purpose: string; gates: string[]; subflows: string[]; typical: string[] }>;
  terminal: Array<{ id: string; label: string; how: string }>;
  subflows: Array<{ id: string; label: string; stage: string; waitKey: string | null; start: string[]; extracted: string | null; cleared: string | null; flagged: string | null; reviewed: string | null; decisionKind: string | null; rule: string }>;
  commands: Array<{ type: string; actor: string; stages: string[] | 'any' | 'not_enrolled'; emits: string[]; description: string; eventuality?: boolean; humanGated?: boolean; hardStop?: boolean }>;
  events: Array<{ type: string; category: string; decision: boolean; humanGated: boolean }>;
  decisions: Array<{ kind: string; label: string; options: string[]; source: string }>;
  timers: { waits: Array<{ waitKey: string; chaseAfter: number; chaseEvery: number | null; escalateAfter: number; reEscalateAfter: number; recipientRole: string; template: string }>; deadlines: Array<{ kind: string; leadWorkingDays: number; description: string }> };
  thresholds: { extractionConfidence: number; classificationConfidence: number };
  invariants: Array<{ id: string; title: string; rule: string; enforcedBy: string[] }>;
  triggers: Array<{ id: string; backend: string; source: string; feeds: string; label: string; description: string; entry: string; implemented: boolean; reaches: string[]; notes?: string }>;
  eventualities: Array<{ area: string; scenario: string; handling: string; mechanism: string }>;
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
  useEffect(() => {
    api<Spec>('/engine/spec').then(setSpec).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the spec.'));
  }, []);
  const areas = useMemo(() => Array.from(new Set(spec?.eventualities.map((e) => e.area) ?? [])), [spec]);

  if (!spec) {
    return (
      <div className="eg" style={{ padding: 24 }}>
        <style>{ENGINE_CSS}</style>
        {err ? <div className="eg-err">{err}</div> : <div className="eg-sub">Loading the machine…</div>}
      </div>
    );
  }
  // ── stage spine geometry ──
  const W = 150, GAP = 22, X0 = 20, Y = 40, H = 54;
  const stageX = (i: number) => X0 + i * (W + GAP);
  const gateLines = spec.stages.map((s) => s.gates.length);
  const spineH = Y + H + 30 + Math.max(...gateLines) * 15 + 70;

  return (
    <div className="eg mp" style={{ maxWidth: 1240, margin: '0 auto', padding: '20px 16px 60px' }}>
      <style>{ENGINE_CSS + CSS}</style>
      <div className="eg-top">
        <div>
          <h1 className="eg-h1">The machine, drawn from code</h1>
          <p className="eg-sub">Residential freehold purchase, buyer side. Spec version <code>{spec.version}</code> · {spec.stages.length} stages · {spec.subflows.length} sub-flows · {spec.commands.length} commands · {spec.events.length} event types · {spec.decisions.length} decision kinds · {spec.triggers.length} triggers · {spec.eventualities.length} eventualities. Read-only; the tests keep it honest.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a className="eg-btn" href="/decisions">Queue</a>
          <a className="eg-btn" href="/api/v1/engine/spec" target="_blank" rel="noreferrer">JSON</a>
        </div>
      </div>

      <h2>1 · The stage spine and its gates</h2>
      <figure>
        <svg viewBox={`0 0 ${X0 * 2 + spec.stages.length * (W + GAP)} ${spineH}`} role="img" aria-label="Eight stages left to right; under each, the gates that must be true to leave it; abandonment and manual handling can leave from any stage.">
          <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#0f172a" /></marker></defs>
          {spec.stages.map((s, i) => (
            <g key={s.id}>
              <rect x={stageX(i)} y={Y} width={W} height={H} rx="10" fill={i === spec.stages.length - 1 ? '#0f172a' : '#fff'} stroke="#0f172a" strokeWidth="1.5" />
              <text x={stageX(i) + W / 2} y={Y + 23} textAnchor="middle" fontSize="13" fontWeight="700" fill={i === spec.stages.length - 1 ? '#fff' : '#0f172a'}>{STAGE_LABEL[s.id] ?? s.label}</text>
              <text x={stageX(i) + W / 2} y={Y + 41} textAnchor="middle" fontSize="10" fill={i === spec.stages.length - 1 ? '#c7d2fe' : '#64748b'}>{s.subflows.length ? s.subflows.join(' · ') : 'milestones'}</text>
              {i < spec.stages.length - 1 && <line x1={stageX(i) + W} y1={Y + H / 2} x2={stageX(i + 1) - 2} y2={Y + H / 2} stroke="#0f172a" strokeWidth="1.4" markerEnd="url(#arr)" />}
              <text x={stageX(i) + 6} y={Y + H + 22} fontSize="10" fontWeight="800" fill="#94a3b8" letterSpacing=".06em">GATES</text>
              {s.gates.map((g, j) => (
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
        <figcaption>A stage is left automatically the moment its gates are all true (stage_advanced, actor system). Gates are the union of sub-flow outcomes and recorded milestones; nothing else moves the stage.</figcaption>
      </figure>

      <h2>2 · The sub-flow pattern, once per sub-flow</h2>
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
        <figcaption>Green: something arrived (external / a person). Blue: the deterministic rule layer cleared it (assist level also raises an advisory review). Purple: flagged by the rule layer, with the AI's summary and citations — a decision. Amber: a person resolved it, with a reason unless approving.</figcaption>
      </figure>
      <table>
        <thead><tr><th>Sub-flow</th><th>Rule (deterministic, never the AI)</th></tr></thead>
        <tbody>{spec.subflows.map((sf) => <tr key={sf.id}><td><b>{sf.label}</b></td><td>{sf.rule}</td></tr>)}</tbody>
      </table>
      <p className="eg-sub" style={{ marginTop: 6 }}>Thresholds: extraction confidence ≥ {spec.thresholds.extractionConfidence} to be acted on (below → flagged for a person); classification confidence ≥ {spec.thresholds.classificationConfidence} to route a document automatically.</p>

      <h2>3 · Commands: who may record what, and when</h2>
      <table>
        <thead><tr><th>Command</th><th>Actor</th><th>Accepted at</th><th>Emits</th><th>What it means</th></tr></thead>
        <tbody>
          {spec.commands.map((c) => (
            <tr key={c.type}>
              <td><code>{c.type}</code>{c.eventuality && <span className="eg-chip info" style={{ marginLeft: 6 }}>eventuality</span>}{c.humanGated && <span className="eg-chip bad" style={{ marginLeft: 6 }}>human gate</span>}{c.hardStop && <span className="eg-chip bad" style={{ marginLeft: 6 }}>hard stop</span>}</td>
              <td><span className={`eg-chip ${c.actor === 'person' ? 'pending' : c.actor === 'automation' ? 'muted' : 'info'}`}>{ACTOR[c.actor]}</span></td>
              <td>{c.stages === 'any' ? <span className="muted">any (enrolled)</span> : c.stages === 'not_enrolled' ? <span className="muted">before enrolment</span> : c.stages.map((s) => STAGE_LABEL[s] ?? s).join(', ')}</td>
              <td>{c.emits.map((e) => <code key={e} style={{ marginRight: 4 }}>{e}</code>)}</td>
              <td>{c.description}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>4 · Time as a trigger</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(420px,1fr))', gap: 12 }}>
        <table>
          <thead><tr><th>Wait (something owed to us)</th><th>Chase after</th><th>Every</th><th>Escalate</th><th>Again after</th><th>Who is chased</th></tr></thead>
          <tbody>{spec.timers.waits.map((w) => <tr key={w.waitKey}><td><b>{w.waitKey.replace(/_/g, ' ')}</b><div className="muted">{w.template}</div></td><td>{w.chaseAfter} wd</td><td>{w.chaseEvery === null ? '—' : `${w.chaseEvery} wd`}</td><td>{w.escalateAfter} wd</td><td>{w.reEscalateAfter} wd</td><td>{w.recipientRole.replace(/_/g, ' ')}</td></tr>)}</tbody>
        </table>
        <table>
          <thead><tr><th>Deadline (something we owe)</th><th>Raised</th><th>What</th></tr></thead>
          <tbody>{spec.timers.deadlines.map((d) => <tr key={d.kind}><td><b>{d.kind.replace(/_/g, ' ')}</b></td><td>{d.leadWorkingDays} wd before</td><td>{d.description}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="eg-sub" style={{ marginTop: 6 }}>Working days, England &amp; Wales. A chase is a template message to the party that owes us; an escalation is a decision for a person with a dossier as its source. Deadlines are raised once each.</p>

      <h2>5 · Triggers: every door into the engine</h2>
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

      <h2>6 · Eventualities: how a real purchase departs from the happy path</h2>
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
      <p className="eg-sub" style={{ marginTop: 6 }}>built = modelled and tested · manual = automation stops, a person runs it · outside = the practice system's job · gap = design noted, not modelled. Full narrative: docs/engine-eventualities.md.</p>

      <h2>7 · Invariants the machine enforces</h2>
      <div className="inv">{spec.invariants.map((v) => <div key={v.id}><b>{v.title}</b>{v.rule}<div className="muted" style={{ marginTop: 4 }}>{v.enforcedBy.join(' · ')}</div></div>)}</div>

      <h2>8 · Decision kinds</h2>
      <table>
        <thead><tr><th>Kind</th><th>Options</th><th>Its source</th></tr></thead>
        <tbody>{spec.decisions.map((d) => <tr key={d.kind}><td><b>{d.label}</b></td><td>{d.options.join(' · ')}</td><td>{d.source}</td></tr>)}</tbody>
      </table>
      <p className="eg-sub" style={{ marginTop: 12 }}>{spec.generatedFrom}</p>
    </div>
  );
}
