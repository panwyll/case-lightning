'use client';
import { BackLink } from '@/app/shared/BackLink';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { STAGE_LABEL, type IssueCatalogue } from '@/app/shared/engine/types';
import { Flow, WORK_CSS, type LaneDef } from '@/app/shared/engine/WorkPanel';
import { ChevronRight } from '@/app/shared/icons';

/**
 * The state machine, drawn from code. Read-only. Everything on this page comes from
 * GET /api/v1/engine/spec, which is built from the machine's own tables and checked
 * against its behaviour by tests — so what you see is what runs.
 */
interface Spec {
  version: string;
  generatedFrom: string;
  shapes: Array<{ id: string; label: string; sides: string[]; summary: string; issue: string; gate: string; fundsFrom: string | null }>;
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
.mp figure{margin:0;background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:12px;overflow-x:auto}
.mp figure svg{display:block;min-width:1180px;height:auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.mp figcaption{font-size:12px;color:#64748b;margin-top:8px}
.mp table{border-collapse:collapse;width:100%;font-size:12.5px;background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden}
.mp th,.mp td{text-align:left;padding:7px 10px;border-top:1px solid #f1f5f9;vertical-align:top}
.mp th{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#94a3b8;border-top:0;background:#fafafa}
.mp code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:#f1f5f9;border-radius:4px;padding:1px 4px}
.mp .muted{color:#94a3b8}
.mp-group{margin-bottom:14px;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden;background:#fff}
.mp-group-h{padding:7px 12px;font-size:11.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}
.mp-cmds{border:0;border-radius:0;table-layout:fixed}
.mp-cmds td,.mp-cmds th{overflow-wrap:anywhere;word-break:break-word}
.mp-cmds td b{font-weight:700;text-transform:capitalize}
.mp-actor{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px;white-space:nowrap}
.mp-actor.person{background:#fef3c7;color:#92400e}
.mp-actor.automation{background:#e2e8f0;color:#334155}
.mp-actor.either{background:#dbeafe;color:#1e40af}
.mp-emits span{display:inline-block;font-size:11px;background:#f8fafc;border:1px solid #e6e8ee;border-radius:6px;padding:1px 6px;margin:0 4px 4px 0;text-transform:capitalize}
.mp-sec{border:1px solid #e6e8ee;border-radius:12px;background:#fafafa;margin:0 0 10px;padding:0 12px}
.mp-sec[open]{background:#fff}
.mp-sec>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:14px 0;font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#0f172a}
.mp-sec>summary::-webkit-details-marker{display:none}
.mp-chev{color:#64748b;transition:transform .12s;flex:none}
.mp-sec[open]>summary .mp-chev{transform:rotate(90deg)}
.mp-sec>*:not(summary){margin-bottom:12px}
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
  const [txType, setTxType] = useState('freehold_purchase');
  const [current, setCurrent] = useState<string | null>(null);
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
  const gatesOf = (st: { id: string; gates: string[] }) => profile?.stageGates[st.id] ?? st.gates;
  const subflowsOf = (st: { id: string; subflows: string[] }) => (profile ? st.subflows.filter((sf) => profile.subflows.includes(sf)) : st.subflows);
  const label = (id: string) => profile?.stageLabels[id] ?? STAGE_LABEL[id] ?? id;
  const step = (text: string | null | undefined) => (text ? [{ label: text.replace(/_/g, ' ').replace(/\bid\b/gi, 'ID').replace(/\baml\b/gi, 'AML').replace(/\bsdlt\b/gi, 'SDLT').replace(/\bap1\b/gi, 'AP1'), status: 'not_started' }] : []);
  // Every stage a band; in it each sub-flow as a box (its event pair as steps) and the gates to leave the stage as the last box.
  const GROUP_COLOUR: Record<string, { bg: string; fg: string }> = {
    not_enrolled: { bg: '#f1f5f9', fg: '#334155' }, instruction: { bg: '#e0f2fe', fg: '#075985' }, pre_contract: { bg: '#dcfce7', fg: '#166534' }, contract_review: { bg: '#fef9c3', fg: '#854d0e' }, pre_exchange: { bg: '#ffedd5', fg: '#9a3412' },
    exchanged: { bg: '#fce7f3', fg: '#9d174d' }, pre_completion: { bg: '#ede9fe', fg: '#5b21b6' }, completed: { bg: '#e0e7ff', fg: '#3730a3' }, post_completion: { bg: '#ccfbf1', fg: '#115e59' }, any: { bg: '#f1f5f9', fg: '#475569' },
  };
  const stageOrder = stagesShown.map((st) => st.id);
  const groupOf = (c: Spec['commands'][number]) => (c.stages === 'not_enrolled' ? 'not_enrolled' : c.stages === 'any' ? 'any' : stageOrder.find((st) => (c.stages as string[]).includes(st)) ?? 'any');
  const commandGroups = ['not_enrolled', ...stageOrder, 'any'].map((id) => ({
    id, label: id === 'not_enrolled' ? 'Before Enrolment' : id === 'any' ? 'Any Stage' : label(id), ...(GROUP_COLOUR[id] ?? GROUP_COLOUR.any),
    items: commandsShown.filter((c) => groupOf(c) === id),
  })).filter((g) => g.items.length);
  const tiers = [
    ...stagesShown.map((st) => {
      const items: LaneDef[] = subflowsOf(st).map((id) => {
        const sf = spec.subflows.find((x) => x.id === id);
        const dk = sf ? spec.decisions.find((d) => d.kind === sf.decisionKind) : null;
        return {
          id: `${st.id}-${id}`, title: sf?.label ?? id.replace(/_/g, ' '), state: 'idle' as const, plain: true, order: 'sequence' as const, note: sf?.rule,
          tiles: sf ? [...step(sf.start[sf.start.length - 1]), ...step(sf.cleared), ...step(sf.flagged), ...step(sf.reviewed ? `${sf.reviewed} — a person${dk ? `: ${dk.options.join(' · ')}` : ''}` : null)] : [],
        };
      });
      items.push({ id: `${st.id}-gates`, title: 'Gates To Leave', state: 'idle', plain: true, order: 'sequence', note: st.purpose, tiles: gatesOf(st).map((g) => ({ label: g, status: 'not_started' })) });
      return { id: st.id, label: label(st.id), items };
    }),
    { id: 'exits', label: 'Exits', items: spec.terminal.map((t) => ({ id: `exit-${t.id}`, title: t.label, state: 'idle' as const, plain: true, tiles: [{ label: t.how, status: 'not_started' }] })) },
  ];

  return (
    <div className="eg mp" style={{ maxWidth: 1100 }}>
      <style>{ENGINE_CSS + WORK_CSS + CSS}</style>
      <div className="eg-top">
        <div>
          <h1 className="eg-h1" style={{ display: 'flex', alignItems: 'center' }}><BackLink href="/conveyi/integrations" label="Back to Tools" />Machine Map</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a className="eg-btn" href="/conveyi/admin?tab=mywork">Tasks</a>
          <a className="eg-btn" href="/api/v1/engine/spec" target="_blank" rel="noreferrer">JSON</a>
        </div>
      </div>

      <details id="transaction-types" className="mp-sec" open>
        <summary><ChevronRight size={18} className="mp-chev" /><span>Transaction Types</span></summary>
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
        <table style={{ marginTop: 10 }}>
          <thead><tr><th>Shape</th><th>Side</th><th>What It Adds</th><th>Holds</th><th>Money From</th></tr></thead>
          <tbody>
            {spec.shapes.filter((sh) => !profile || sh.sides.includes(profile.side)).map((sh) => (
              <tr key={sh.id}><td><b>{sh.label}</b></td><td>{sh.sides.join(', ')}</td><td>{sh.summary}<div className="muted" style={{ marginTop: 3 }}>{sh.issue}</div></td><td>{sh.gate}</td><td>{sh.fundsFrom ? sh.fundsFrom.replace(/_/g, ' ') : <span className="muted">—</span>}</td></tr>
            ))}
          </tbody>
        </table>
      </details>

      <details id="stages" className="mp-sec" open>
        <summary><ChevronRight size={18} className="mp-chev" /><span>Stages{profile ? ` — ${profile.label}` : ''}</span></summary>
        <div className="ep">
          <Flow tiers={tiers} current={current} toggle={(l) => setCurrent((c) => (c === l.id ? null : l.id))} noticeFor={() => null} />
        </div>
      </details>

      <details id="sub-flows" className="mp-sec">
        <summary><ChevronRight size={18} className="mp-chev" /><span>Sub-flows</span></summary>
      <table>
        <thead><tr><th>Sub-flow</th><th>Rule</th></tr></thead>
        <tbody>{spec.subflows.map((sf) => <tr key={sf.id}><td><b>{sf.label}</b></td><td>{sf.rule}</td></tr>)}</tbody>
      </table>
      </details>

      <details id="commands" className="mp-sec">
        <summary><ChevronRight size={18} className="mp-chev" /><span>Commands{profile ? ` — ${profile.label}` : ''}</span></summary>
        {commandGroups.map((g) => (
          <div key={g.id} className="mp-group">
            <div className="mp-group-h" style={{ background: g.bg, color: g.fg }}>{g.label}</div>
            <table className="mp-cmds">
              <colgroup><col style={{ width: '24%' }} /><col style={{ width: '12%' }} /><col style={{ width: '18%' }} /><col style={{ width: '20%' }} /><col /></colgroup>
              <thead><tr><th>Command</th><th>Actor</th><th>Accepted At</th><th>Emits</th><th>Meaning</th></tr></thead>
              <tbody>
                {g.items.map((c) => (
                  <tr key={c.type} style={{ boxShadow: `inset 3px 0 0 ${g.fg}` }}>
                    <td><b>{c.type.replace(/_/g, ' ').replace(/\bid\b/gi, 'ID').replace(/\bsdlt\b/gi, 'SDLT').replace(/\bap1\b/gi, 'AP1').replace(/\bpof\b/gi, 'proof of funds')}</b>{c.eventuality && <span className="eg-chip info" style={{ marginLeft: 6 }}>eventuality</span>}{c.humanGated && <span className="eg-chip bad" style={{ marginLeft: 6 }}>human gated</span>}{c.hardStop && <span className="eg-chip muted" style={{ marginLeft: 6 }}>hard stop</span>}</td>
                    <td><span className={`mp-actor ${c.actor}`}>{ACTOR[c.actor]}</span></td>
                    <td>{c.stages === 'any' ? <span className="muted">any (enrolled)</span> : c.stages === 'not_enrolled' ? <span className="muted">before enrolment</span> : c.stages.filter((st) => !profile || profile.stages.includes(st)).map((st) => label(st)).join(', ')}</td>
                    <td className="mp-emits">{c.emits.map((e) => <span key={e}>{e.replace(/_/g, ' ')}</span>)}</td>
                    <td>{c.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </details>

      <details id="timers" className="mp-sec">
        <summary><ChevronRight size={18} className="mp-chev" /><span>Timers</span></summary>
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
      </details>

      <details id="triggers" className="mp-sec">
        <summary><ChevronRight size={18} className="mp-chev" /><span>Triggers</span></summary>
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
      </details>

      <details id="eventualities" className="mp-sec">
        <summary><ChevronRight size={18} className="mp-chev" /><span>Eventualities</span></summary>
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
      </details>

      <details id="issues" className="mp-sec">
        <summary><ChevronRight size={18} className="mp-chev" /><span>Issues</span></summary>
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
      </details>

      <details id="invariants" className="mp-sec">
        <summary><ChevronRight size={18} className="mp-chev" /><span>Invariants</span></summary>
      <div className="inv">{spec.invariants.map((v) => <div key={v.id}><b>{v.title}</b>{v.rule}<div className="muted" style={{ marginTop: 4 }}>{v.enforcedBy.join(' · ')}</div></div>)}</div>
      </details>

      <details id="decision-kinds" className="mp-sec">
        <summary><ChevronRight size={18} className="mp-chev" /><span>Decision Kinds</span></summary>
      <table>
        <thead><tr><th>Kind</th><th>Options</th><th>Its source</th></tr></thead>
        <tbody>{spec.decisions.map((d) => <tr key={d.kind}><td><b>{d.label}</b></td><td>{d.options.join(' · ')}</td><td>{d.source}</td></tr>)}</tbody>
      </table>
      </details>

    </div>
  );
}
