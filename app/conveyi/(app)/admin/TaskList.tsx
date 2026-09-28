'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PasswordInput } from '@/app/shared/engine/PasswordInput';
import { api } from '@/app/shared/engine/api';
import { House } from '@/app/shared/engine/CaseloadMap';
import { DecisionPanel } from '@/app/shared/engine/DecisionPanel';
import { type WorkItem , KIND_LABEL , pretty , chipLabel , quickApprovable } from '@/app/shared/engine/types';
import { paths } from '@/lib/paths';
import { ChevronRight, CheckCircle } from '@/app/shared/icons';
import { Waiting, WORK_CSS } from './EngineWork';

/**
 * Tasks: one list. Everything a person has to do, grouped by the case it belongs to, most
 * pressing first. A decision opens in place as the same brief the decision page shows;
 * anything else is a step on the case. Waiting sits underneath and chases itself.
 */
const CSS = `
.tl-bar{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
.tl-bar label{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:#64748b}
.tl-bar select{border:1px solid #d0d5dd;border-radius:8px;padding:5px 10px;font-size:12.5px;font-weight:700;color:#0f172a;background:#fff;cursor:pointer;font-family:inherit;max-width:280px}
.tl-bar .n{margin-left:auto;font-size:12.5px;color:#94a3b8;font-variant-numeric:tabular-nums}
.tl-group{background:#fff;border:1px solid #e6e8ee;border-radius:12px;margin-bottom:10px;overflow:hidden}
.tl-case{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #f1f5f9;text-decoration:none;color:inherit}
.tl-case:hover{background:#fafafa}
.tl-case b{font-size:13.5px;font-weight:800;color:#0f172a}
.tl-case .ref{font-size:12px;color:#5A27E0;font-weight:700}
.tl-case .who{font-size:12px;color:#64748b;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}
.tl-task{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:6px 14px;align-items:center;padding:13px 14px 13px 40px;border-top:1px solid #e6e8ee}
.tl-task:first-of-type{border-top:0}
.tl-task .what{font-size:13.5px;font-weight:600;line-height:1.35;color:#0f172a}
.tl-chip{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#475569;background:#f1f5f9;border-radius:999px;padding:2px 8px;margin-right:8px;vertical-align:1px}
.tl-chip.prop{color:#5A27E0;background:#f5f3ff}
.tl-task .sub{font-size:12px;color:#64748b;margin-top:2px}
.tl-task .age{font-size:12px;color:#94a3b8;white-space:nowrap;font-variant-numeric:tabular-nums}
.tl-task .age.over{color:#b91c1c;font-weight:700}
.tl-task .age.soon{color:#b45309;font-weight:700}
.tl-btn{border:1px solid #5A27E0;background:#fff;color:#5A27E0;border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;text-decoration:none}
.tl-btn:hover{background:#f5f3ff}
.tl-btn.go{background:#5A27E0;color:#fff}
.tl-btn.go:hover{background:#4c1fc4}
.tl-btn.on{background:#fff;color:#64748b;border-color:#e2e8f0;padding:6px 8px}
.tl-item.open{background:#f8f7ff;box-shadow:inset 3px 0 0 #5A27E0;border-top:1px solid #e6e8ee;border-bottom:1px solid #e6e8ee;margin:6px 0}
.tl-item.open .tl-task{border-top:0}
.tl-item.open + .tl-item .tl-task{border-top:0}
.tl-open{padding:0 14px 14px 40px}
.tl-open .dp.inline{border:1px solid #e6e8ee;border-radius:12px;background:#fff}
.tl-for{font-size:11.5px;font-weight:700;color:#64748b;background:#f1f5f9;border-radius:999px;padding:4px 10px;white-space:nowrap}
.tl-pw{display:inline-flex;gap:6px;align-items:center}
.tl-pw input{border:1px solid #cbd5e1;border-radius:8px;padding:6px 9px;font:inherit;font-size:12.5px;width:150px}
.tl-out{padding:10px 14px;border-radius:10px;margin-bottom:10px;font-size:13px;font-weight:600;background:#dcfce7;color:#166534;border:1px solid #bbf7d0}
.tl-out.warn{background:#fef3c7;color:#92400e;border-color:#fde68a}
.tl-clear{display:flex;align-items:center;gap:8px;padding:14px;font-size:13px;color:#166534;background:#fff;border:1px solid #e6e8ee;border-radius:12px;margin-bottom:10px}
.tl-clear .t{color:#94a3b8;font-size:12px;margin-left:auto;font-variant-numeric:tabular-nums}
`;

type Sort = 'urgency' | 'due' | 'case';
const RANK: Record<string, number> = { critical: 0, blocked: 1, delayed: 2, attention: 3, normal: 4 };
const dayMs = 86_400_000;
const dueIn = (i: WorkItem, now: number): number | null => (i.dueBy ? Math.floor((new Date(`${i.dueBy}T23:59:59`).getTime() - now) / dayMs) : null);
const ageDays = (i: WorkItem, now: number): number | null => (i.since ? Math.floor((now - new Date(i.since).getTime()) / dayMs) : null);
/** The task in a sentence, without the engine's prefixes. */
const sentence = (w: string): string => w.replace(/^Decide:\s*/i, '').trim().replace(/^\w/, (c) => c.toUpperCase());

export default function TaskList({ who }: { who: string }) {
  const [data, setData] = useState<{ do: WorkItem[]; waiting: WorkItem[]; escalate: WorkItem[]; viewerRole?: string } | null>(null);
  // An assistant sees every task on their cases; the ones that are a conveyancer's call say so instead of offering Approve.
  const forConveyancer = (i: WorkItem): boolean => data?.viewerRole === 'ASSISTANT' && !i.assistantCan;
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [sort, setSort] = useState<Sort>('urgency');
  const [caseId, setCaseId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [quickErr, setQuickErr] = useState<{ id: string; text: string } | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const retry = async (matterId: string, issueId: string) => {
    setRetrying(issueId); setQuickErr(null);
    try { await api(`/matters/${matterId}/engine`, { method: 'POST', body: JSON.stringify({ type: 'retry_issue', issueId }) }); await load(); window.dispatchEvent(new Event('conveyi:counts')); }
    catch (e: unknown) { setQuickErr({ id: issueId, text: e instanceof Error ? e.message : 'Could not send it again.' }); }
    finally { setRetrying(null); }
  };
  const [unlockingId, setUnlockingId] = useState<string | null>(null);
  const [pwd, setPwd] = useState('');
  const [unlockBusy, setUnlockBusy] = useState(false);
  /** What the last unlock did, said plainly for a few seconds. */
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (!outcome) return; const t = setTimeout(() => setOutcome(null), 8000); return () => clearTimeout(t); }, [outcome]);
  /** A locked file opened from its task: the right password unlocks it, closes the task and reads the file. */
  const unlock = async (i: WorkItem) => {
    setUnlockBusy(true); setQuickErr(null);
    try {
      const r = await api<{ note: string | null; warning: string | null }>(`/documents/${i.documentId}/unlock`, { method: 'POST', body: JSON.stringify({ password: pwd, from: 'task' }) });
      setUnlockingId(null); setPwd('');
      setOutcome({ ok: !r.warning, text: r.warning ?? r.note ?? 'Unlocked.' });
      await load(); window.dispatchEvent(new Event('conveyi:counts'));
    }
    catch (e: unknown) { setQuickErr({ id: i.ref?.id ?? i.id, text: e instanceof Error ? e.message : 'That password does not open the file.' }); }
    finally { setUnlockBusy(false); }
  };
  const quickApprove = async (key: string, eventId: string) => {
    setApproving(eventId);
    setQuickErr(null);
    try { await api(`/decisions/${eventId}/resolve`, { method: 'POST', body: JSON.stringify({ option: 'approve' }) }); await load(); }
    catch (e: unknown) { setQuickErr({ id: eventId, text: e instanceof Error ? e.message : 'Could not approve.' }); setOpen(key); }
    finally { setApproving(null); }
  };
  const load = useCallback(async () => {
    try { setData(await api(who ? `/engine/my-work?user=${who}` : '/engine/my-work?all=1')); setCheckedAt(new Date()); } catch { setData(null); }
  }, [who]);
  useEffect(() => { void load(); }, [load]);

  const now = Date.now();
  const tasks = useMemo(() => {
    if (!data) return [];
    const all = [...data.do, ...data.escalate];
    const filtered = caseId ? all.filter((i) => i.matterId === caseId) : all;
    const by: Record<Sort, (a: WorkItem, b: WorkItem) => number> = {
      urgency: (a, b) => (RANK[a.urgency] ?? 9) - (RANK[b.urgency] ?? 9) || (ageDays(b, now) ?? 0) - (ageDays(a, now) ?? 0),
      due: (a, b) => (dueIn(a, now) ?? ageDays(a, now) == null ? 9999 : -(ageDays(a, now) ?? 0)) - (dueIn(b, now) ?? ageDays(b, now) == null ? 9999 : -(ageDays(b, now) ?? 0)),
      case: (a, b) => (a.propertyAddress ?? a.matterRef ?? '').localeCompare(b.propertyAddress ?? b.matterRef ?? '') || (RANK[a.urgency] ?? 9) - (RANK[b.urgency] ?? 9),
    };
    return filtered.slice().sort(by[sort]);
  }, [data, caseId, sort, now]);

  // Grouped by case, in the order the sort puts their first task.
  const groups = useMemo(() => {
    const m = new Map<string, { matterId: string; address: string; ref: string | null; clients: string[]; band: string; items: WorkItem[] }>();
    for (const i of tasks) {
      const g = m.get(i.matterId) ?? { matterId: i.matterId, address: i.propertyAddress ?? i.matterRef ?? 'Case', ref: i.matterRef, clients: i.clients ?? [], band: i.urgency, items: [] };
      g.items.push(i);
      if ((RANK[i.urgency] ?? 9) < (RANK[g.band] ?? 9)) g.band = i.urgency;
      m.set(i.matterId, g);
    }
    return Array.from(m.values());
  }, [tasks]);
  const cases = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of [...(data?.do ?? []), ...(data?.escalate ?? [])]) m.set(i.matterId, i.propertyAddress ?? i.matterRef ?? 'Case');
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  if (!data) return null;
  return (
    <div>
      <style>{WORK_CSS + CSS}</style>
      <div className="tl-bar">
        <label>Sort<select value={sort} onChange={(e) => setSort(e.target.value as Sort)}><option value="urgency">Urgency</option><option value="due">Due date</option><option value="case">Case</option></select></label>
        <label>Case<select value={caseId} onChange={(e) => setCaseId(e.target.value)}><option value="">All cases</option>{cases.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <span className="n">{tasks.length} task{tasks.length === 1 ? '' : 's'}{groups.length > 1 ? ` across ${groups.length} cases` : ''}</span>
      </div>
      {outcome && <div className={`tl-out${outcome.ok ? '' : ' warn'}`} role="status">{outcome.text}</div>}
      {tasks.length === 0 && checkedAt && (
        <div className="tl-clear"><CheckCircle size={16} /><span>All clear</span><span className="t">checked {checkedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span></div>
      )}
      {groups.map((g) => (
        <div key={g.matterId} className="tl-group">
          <a className="tl-case" href={paths.matter(g.matterId)}>
            <House band={g.band as never} size={18} />
            <b>{g.address}</b>
            {g.ref && <span className="ref">{g.ref}</span>}
            {g.clients.length > 0 && <span className="who">{g.clients.join(' & ')}</span>}
          </a>
          {g.items.map((i) => {
            const isDecision = i.ref?.type === 'decision';
            const key = `${i.matterId}:${i.id}`;
            const isOpen = open === key;
            const due = dueIn(i, now);
            const age = ageDays(i, now);
            return (
              <div key={key} className={`tl-item${isOpen ? ' open' : ''}`}>
                <div className="tl-task">
                  <div>
                    <div className="what">{i.kind && <span className={`tl-chip${i.kind.startsWith('proposal') ? ' prop' : ''}`}>{i.chip ?? chipLabel(i.kind)}</span>}{sentence(i.what)}</div>
                    {quickErr?.id === i.ref?.id && <div className="sub" style={{ color: '#b91c1c' }}>{quickErr.text}</div>}
                    {(i.unblocks || i.bucket === 'escalate') && <div className="sub">{i.bucket === 'escalate' ? 'Escalated: writing again will not fix it' : `Unblocks ${i.unblocks!.toLowerCase()}`}</div>}
                  </div>
                  <span className={`age${due != null && due < 0 ? ' over' : due != null && due <= 2 ? ' soon' : ''}`}>{due != null ? (due < 0 ? `${-due}d overdue` : due === 0 ? 'due today' : `due in ${due}d`) : age != null ? (age === 0 ? 'since today' : `waiting ${age}d`) : ''}</span>
                  {isDecision && forConveyancer(i) && <span className="tl-for">For A Conveyancer</span>}
                  {isDecision && !forConveyancer(i) && quickApprovable(i.kind) && !isOpen && <button type="button" className="tl-btn go" disabled={approving === i.ref.id} onClick={() => void quickApprove(key, i.ref.id)}>{approving === i.ref.id ? 'Approving…' : 'Approve'}</button>}
                  {isDecision
                    ? <button type="button" className={`tl-btn${isOpen ? ' on' : ''}`} aria-label={isOpen ? 'Collapse' : 'Review'} onClick={() => setOpen(isOpen ? null : key)}>{isOpen ? null : 'Review '}<ChevronRight size={14} style={{ transform: isOpen ? 'rotate(90deg)' : undefined }} /></button>
                    : <>
                      {i.kind === 'issue:file_locked' && i.documentId && (unlockingId === i.id
                        ? <span className="tl-pw"><PasswordInput autoFocus value={pwd} onChange={setPwd} onEnter={() => void unlock(i)} onEscape={() => setUnlockingId(null)} style={{ width: 190 }} /><button type="button" className="tl-btn go" disabled={!pwd || unlockBusy} onClick={() => void unlock(i)}>{unlockBusy ? 'Unlocking…' : 'Unlock'}</button></span>
                        : <button type="button" className="tl-btn go" onClick={() => { setUnlockingId(i.id); setPwd(''); }}>Enter Password</button>)}
                      {i.kind === 'issue:send_failed:retry' && <button type="button" className="tl-btn go" disabled={retrying === i.ref.id} onClick={() => void retry(i.matterId, i.ref.id)}>{retrying === i.ref.id ? 'Sending…' : 'Try Again'}</button>}
                      <a className="tl-btn" href={`${paths.matter(i.matterId)}${i.ref?.type === 'issue' ? '?tab=tasks' : ''}`}>{i.ref?.type === 'issue' ? 'Open issue' : 'Open case'} <ChevronRight size={14} /></a>
                    </>}
                </div>
                {isOpen && isDecision && (
                  <div className="tl-open">
                    <DecisionPanel eventId={i.ref.id} inline onResolved={() => { setOpen(null); void load(); }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {data.waiting.length > 0 && <Waiting items={data.waiting} onChanged={() => void load()} />}
    </div>
  );
}
