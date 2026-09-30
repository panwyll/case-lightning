'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Hand } from '@/app/shared/icons';
import { BusyButton } from './BusyButton';
import { IssuesPanel } from './IssuesPanel';
import type { Api, EngineState } from './types';
import { WORK_CSS } from './WorkPanel';

/**
 * A task's header: raise an issue on its case, and take the case over by hand (or hand it back).
 * Icons only; each opens its own small form. The case is read when one is first opened.
 */
const CSS = `
.cqa{position:relative;display:inline-flex;gap:4px;align-items:center}
.cqa-b{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border:1px solid #e2e8f0;background:#fff;border-radius:8px;color:#475569;cursor:pointer;padding:0}
.cqa-b:hover{border-color:#5A27E0;color:#5A27E0}
.cqa-b.on{border-color:#f59e0b;color:#b45309;background:#fffbeb}
.cqa-pop{position:absolute;top:36px;right:0;z-index:50;width:320px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.14);padding:12px;display:grid;gap:8px;text-align:left}
.cqa-pop b{font-size:13px;color:#0f172a}
.cqa-pop textarea{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font:inherit;font-size:13px;resize:vertical}
.cqa-pop .f{display:flex;gap:6px;justify-content:flex-end}
.cqa-pop .bad{font-size:12.5px;color:#b91c1c;font-weight:600}
`;

export function CaseQuickActions({ api, matterId, onChanged }: { api: Api; matterId: string; onChanged?: () => void }) {
  const [state, setState] = useState<EngineState | null>(null);
  const [open, setOpen] = useState<'issue' | 'manual' | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement | null>(null);
  const load = async () => { const v = await api<{ state: EngineState }>(`/matters/${matterId}/engine`).catch(() => null); if (v) setState(v.state); return v?.state ?? null; };
  useEffect(() => { void load(); }, [matterId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open !== 'manual') return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const cmd = async (body: Record<string, unknown>) => { await api(`/matters/${matterId}/engine`, { method: 'POST', body: JSON.stringify(body) }); await load(); onChanged?.(); return true; };
  const manual = !!state?.manualHandling?.required;
  // What each button does, shown on hover or focus (the tooltip style of the rest of the case).
  const [tip, setTip] = useState<{ which: 'issue' | 'manual'; x: number; y: number } | null>(null);
  const showTip = (which: 'issue' | 'manual') => (e: { currentTarget: HTMLElement }) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ which, x: Math.max(8, Math.min(r.right - 264, window.innerWidth - 272)), y: r.bottom + 6 }); };
  const TIPS = {
    issue: <><b>Raise Issue</b><br />Record a problem on this case the engine has not caught. It holds exchange or completion until it is resolved, and it goes on the Tasks list. Most issues are raised for you: this is for the ones that are not.</>,
    manual: manual
      ? <><b>Manual Mode</b><br />The engine is not acting on this case on its own: nothing is sent or ordered without you, and steps are marked complete by hand. Click to resume automation.</>
      : <><b>Take Over Manually</b><br />Stop the engine acting on this case on its own: nothing is sent or ordered without you, everything becomes a task, and steps can be marked complete by hand. For a case that cannot run the normal way.</>,
  };
  const hover = (which: 'issue' | 'manual') => ({ onMouseEnter: showTip(which), onFocus: showTip(which), onMouseLeave: () => setTip(null), onBlur: () => setTip(null) });
  const done = !!state?.completion?.confirmedAt || !!state?.abandoned;

  return (
    <span className="cqa" ref={box}>
      <style>{WORK_CSS + CSS}</style>
      {!done && <button type="button" className="cqa-b" aria-label="Raise Issue" {...hover('issue')} onClick={() => { setTip(null); setErr(null); setOpen(open === 'issue' ? null : 'issue'); }}><AlertTriangle size={16} /></button>}
      {!done && <button type="button" className={`cqa-b${manual ? ' on' : ''}`} aria-label={manual ? 'Resume Automation' : 'Take Over Manually'} {...hover('manual')} onClick={() => { setTip(null); setErr(null); setReason(''); setOpen(open === 'manual' ? null : 'manual'); }}><Hand size={16} /></button>}
      {tip && !open && createPortal(<div className="ep-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>{TIPS[tip.which]}</div>, document.body)}
      {open === 'issue' && state && (
        <IssuesPanel api={api} state={state} busy={false} raiseOnly onCancel={() => setOpen(null)} onChanged={() => { void load(); onChanged?.(); }} cmd={async (body) => { try { return await cmd(body); } catch (e: unknown) { throw e instanceof Error ? e : new Error('It did not save.'); } }} />
      )}
      {open === 'manual' && (
        <span className="cqa-pop" role="dialog" aria-label={manual ? 'Resume Automation' : 'Take Over Manually'}>
          <b>{manual ? 'Resume Automation' : 'Take Over Manually'}</b>
          <textarea rows={2} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={manual ? 'Why it can run on its own again' : 'Why this case needs handling by hand'} aria-label="Reason" />
          {err && <span className="bad">{err}</span>}
          <span className="f">
            <button type="button" className="ep-btn" style={{ margin: 0 }} onClick={() => setOpen(null)}>Cancel</button>
            <BusyButton disabled={reason.trim().length < 3} busyLabel={manual ? 'Resuming…' : 'Taking Over…'} doneLabel={manual ? 'Resumed' : 'Taken Over'} onClick={async () => {
              setErr(null);
              try { await cmd(manual ? { type: 'resume_automation', reason: reason.trim() } : { type: 'mark_manual_handling', reason: reason.trim() }); setTimeout(() => setOpen(null), 900); return true; }
              catch (e: unknown) { setErr(e instanceof Error ? e.message : 'It did not save.'); return false; }
            }}>{manual ? 'Resume Automation' : 'Take Over Manually'}</BusyButton>
          </span>
        </span>
      )}
    </span>
  );
}
