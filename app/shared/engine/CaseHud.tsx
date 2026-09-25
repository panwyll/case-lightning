'use client';
import { useState } from 'react';
import { AlertTriangle, Ban, Check, ChevronDown, ChevronRight, Circle, CircleDot, Clock } from '@/app/shared/icons';

/**
 * Where a case is, at a glance: the stages in order, the workstreams running inside each,
 * and the steps inside each workstream. Stages open to their workstreams; a workstream
 * opens to its steps. The current stage is open by default.
 */
export type HudStatus = 'done' | 'waiting' | 'todo' | 'blocked' | 'at_risk' | 'not_started';
export interface HudStep { label: string; status: HudStatus; note: string | null }
export interface HudWorkstream { id: string; label: string; status: HudStatus; summary: string; steps: HudStep[] }
export interface HudStage { id: string; label: string; status: HudStatus; position: 'past' | 'current' | 'future'; done: number; total: number; workstreams: HudWorkstream[] }
export interface CaseHudData { stages: HudStage[]; current: string }

export const HUD_LOOK: Record<HudStatus, { word: string; colour: string; bg: string; Icon: (p: { size?: number }) => JSX.Element }> = {
  done: { word: 'Done', colour: '#15803d', bg: '#dcfce7', Icon: Check },
  waiting: { word: 'Waiting', colour: '#0369a1', bg: '#e0f2fe', Icon: Clock },
  todo: { word: 'To do', colour: '#6d28d9', bg: '#ede9fe', Icon: CircleDot },
  at_risk: { word: 'At risk', colour: '#b45309', bg: '#fef3c7', Icon: AlertTriangle },
  blocked: { word: 'Blocked', colour: '#b91c1c', bg: '#fee2e2', Icon: Ban },
  not_started: { word: 'Not started', colour: '#94a3b8', bg: '#f1f5f9', Icon: Circle },
};

const CSS = `
.hud{background:#fff;border:1px solid #e6e8ee;border-radius:14px;overflow:hidden}
.hud-stage{border-top:1px solid #eef1f5}
.hud-stage:first-child{border-top:0}
.hud-srow{display:grid;grid-template-columns:30px minmax(150px,210px) 1fr auto 18px;gap:12px;align-items:center;width:100%;padding:11px 16px;border:0;background:none;font-family:inherit;text-align:left;cursor:pointer;color:#0f172a}
.hud-srow:hover{background:#fafbfc}
.hud-srow.static{cursor:default}
.hud-srow.static:hover{background:none}
.hud-dot{width:28px;height:28px;border-radius:999px;display:flex;align-items:center;justify-content:center}
.hud-name{font-size:14px;font-weight:800;display:flex;align-items:center;gap:8px;min-width:0}
.hud-now{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:#5A27E0;border-radius:999px;padding:2px 7px}
.hud-chips{display:flex;gap:6px;flex-wrap:wrap;min-width:0}
.hud-chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;border-radius:999px;padding:3px 9px 3px 6px;white-space:nowrap}
.hud-count{font-size:12px;color:#94a3b8;font-variant-numeric:tabular-nums;white-space:nowrap}
.hud-chev{color:#94a3b8;display:flex}
.hud-body{padding:2px 16px 12px 58px}
.hud-ws{border:1px solid #eef1f5;border-radius:10px;margin-top:6px;overflow:hidden;background:#fcfcfd}
.hud-wrow{display:grid;grid-template-columns:22px minmax(120px,190px) 1fr auto 16px;gap:10px;align-items:center;width:100%;padding:9px 12px;border:0;background:none;font-family:inherit;text-align:left;cursor:pointer;color:#0f172a}
.hud-wrow:hover{background:#f6f7f9}
.hud-wname{font-size:13.5px;font-weight:700}
.hud-wsum{font-size:12.5px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hud-word{font-size:12px;font-weight:800;white-space:nowrap}
.hud-steps{padding:2px 12px 10px 44px}
.hud-step{display:grid;grid-template-columns:18px 1fr;gap:8px;align-items:start;padding:5px 0;font-size:13px;color:#0f172a;border-top:1px dashed #eef1f5}
.hud-step:first-child{border-top:0}
.hud-step .n{display:block;font-size:12px;color:#64748b;margin-top:1px}
@media (max-width:760px){.hud-srow{grid-template-columns:30px 1fr 18px}.hud-chips,.hud-count{display:none}.hud-body{padding-left:16px}.hud-wrow{grid-template-columns:22px 1fr auto 16px}.hud-wsum{display:none}}
`;

function Dot({ status, size = 28 }: { status: HudStatus; size?: number }) {
  const l = HUD_LOOK[status];
  return <span className="hud-dot" style={{ background: l.bg, color: l.colour, width: size, height: size }}><l.Icon size={Math.round(size * 0.55)} /></span>;
}

function Workstream({ w }: { w: HudWorkstream }) {
  const [open, setOpen] = useState(false);
  const l = HUD_LOOK[w.status];
  return (
    <div className="hud-ws">
      <button className="hud-wrow" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Dot status={w.status} size={22} />
        <span className="hud-wname">{w.label}</span>
        <span className="hud-wsum">{w.summary}</span>
        <span className="hud-word" style={{ color: l.colour }}>{l.word}</span>
        <span className="hud-chev">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
      </button>
      {open && w.steps.length > 0 && (
        <div className="hud-steps">
          {w.steps.map((s, i) => {
            const sl = HUD_LOOK[s.status];
            return (
              <div key={i} className="hud-step">
                <span style={{ color: sl.colour, display: 'flex', paddingTop: 2 }}><sl.Icon size={14} /></span>
                <span>{s.label}{s.note && <span className="n">{s.note}</span>}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CaseHud({ hud }: { hud: CaseHudData }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set([hud.current]));
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="hud">
      <style>{CSS}</style>
      {hud.stages.map((st) => {
        const isOpen = open.has(st.id) && st.workstreams.length > 0;
        const canOpen = st.workstreams.length > 0;
        return (
          <div key={st.id} className="hud-stage">
            <button className={`hud-srow${canOpen ? '' : ' static'}`} onClick={() => canOpen && toggle(st.id)} aria-expanded={canOpen ? isOpen : undefined}>
              <Dot status={st.status} />
              <span className="hud-name">{st.label}{st.position === 'current' && <span className="hud-now">Now</span>}</span>
              <span className="hud-chips">
                {!isOpen && st.workstreams.map((w) => {
                  const l = HUD_LOOK[w.status];
                  return <span key={w.id} className="hud-chip" style={{ background: l.bg, color: l.colour }}><l.Icon size={12} />{w.label}</span>;
                })}
              </span>
              <span className="hud-count">{st.total > 0 ? `${st.done}/${st.total}` : ''}</span>
              <span className="hud-chev">{canOpen ? (isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />) : null}</span>
            </button>
            {isOpen && (
              <div className="hud-body">
                {st.workstreams.map((w) => <Workstream key={w.id} w={w} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
