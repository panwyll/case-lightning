'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PasswordInput } from '@/app/shared/engine/PasswordInput';
import { api } from '@/app/shared/engine/api';
import { House } from '@/app/shared/engine/CaseloadMap';
import { DecisionPanel } from '@/app/shared/engine/DecisionPanel';
import { IssueReview, StepReview } from '@/app/shared/engine/StepReview';
import { type WorkItem , KIND_LABEL , pretty , chipLabel , quickApprovable } from '@/app/shared/engine/types';
import { paths } from '@/lib/paths';
import { ChevronRight, CheckCircle, Search, X } from '@/app/shared/icons';
import { Waiting, WORK_CSS } from './EngineWork';

/**
 * Tasks: one list. Everything a person has to do, grouped by the case it belongs to, most
 * pressing first. A decision opens in place as the same brief the decision page shows;
 * anything else is a step on the case. Waiting sits underneath and chases itself.
 */
const CSS = `
.tl-bar{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
.tl-bar label{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:#64748b}
.tl-step{padding:12px 14px 14px 40px}
.tl-x{width:28px;height:28px;padding:0;border:0;background:none;color:#94a3b8;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:none}
.tl-x:hover{background:#fee2e2;color:#b91c1c}
.tl-dis{margin-top:14px;border:1px solid #e6e8ee;border-radius:12px;background:#fff}
.tl-dis > button{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;padding:10px 14px;font:inherit;font-size:13px;font-weight:800;color:#0f172a;cursor:pointer;text-align:left}
.tl-dis .n{color:#94a3b8;font-weight:600}
.tl-dis-tools{display:flex;gap:10px;flex-wrap:wrap;padding:4px 14px 10px}
.tl-dis-tools label{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:#64748b}
.tl-dis-tools select{border:1px solid #d0d5dd;border-radius:8px;padding:5px 10px;font-size:12.5px;font-weight:700;color:#0f172a;background:#fff;cursor:pointer;font-family:inherit}
.tl-dis-row{display:flex;align-items:center;gap:10px;padding:8px 14px;border-top:1px solid #f1f5f9;font-size:13px;color:#334155}
.tl-dis-row .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-dis-row .m{color:#94a3b8;font-size:12px;white-space:nowrap}
.tl-q{position:relative;flex:1;min-width:220px;max-width:420px}
.tl-q svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:#94a3b8}
.tl-q input{width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:8px;padding:6px 10px 6px 32px;font-size:12.5px;font-family:inherit}
.tl-q input:focus{outline:2px solid #c4b5fd;border-color:#8b5cf6}
.tl-bar select{border:1px solid #d0d5dd;border-radius:8px;padding:5px 10px;font-size:12.5px;font-weight:700;color:#0f172a;background:#fff;cursor:pointer;font-family:inherit;max-width:280px}
.tl-bar .n{margin-left:auto;font-size:12.5px;color:#94a3b8;font-variant-numeric:tabular-nums}
.tl-groups{background:#fff;border:1px solid #e2dcf5;border-radius:12px;overflow:hidden;margin-bottom:12px}
.tl-group + .tl-group{border-top:1px solid #e2dcf5}
.tl-case{display:flex;align-items:center;gap:10px;padding:9px 14px;background:#f3f0fb;color:inherit;cursor:pointer;user-select:none}
.tl-case:hover{background:#ece7fa}
.tl-case .chev{display:inline-flex;color:#5A27E0;transition:transform .12s}
.tl-case .chev.open{transform:rotate(90deg)}
.tl-case a{text-decoration:none;color:inherit;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-case a:hover b{color:#5A27E0}
.tl-case .cnt{font-size:11.5px;font-weight:800;color:#5A27E0;background:#fff;border:1px solid #d9d0f7;border-radius:99px;padding:1px 8px}
.tl-case b{font-size:13.5px;font-weight:800;color:#0f172a}
.tl-case .ref{font-size:12px;color:#5A27E0;font-weight:700}
.tl-case .who{font-size:12px;color:#64748b;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}
.tl-task{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px 14px;align-items:center;padding:13px 14px 13px 40px;border-top:1px solid #e6e8ee}
.tl-task:first-of-type{border-top:0}
.tl-task .what{font-size:13.5px;font-weight:600;line-height:1.35;color:#0f172a}
.tl-chip{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#475569;background:#f1f5f9;border-radius:999px;padding:2px 8px;margin-right:8px;vertical-align:1px}
.tl-chip.prop{color:#5A27E0;background:#f5f3ff}
.tl-task .sub{font-size:12px;color:#64748b;margin-top:2px}
.tl-acts{display:flex;align-items:center;gap:6px;justify-content:flex-end}
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
/** When a task arose, as a time: today and yesterday by clock time, older by date. */
const stamp = (iso: string): string => {
  const d = new Date(iso);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return days <= 0 ? `Today ${time}` : days === 1 ? `Yesterday ${time}` : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}) });
};
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
  const [q, setQ] = useState('');
  // Tasks dismissed from the tray: listed under Dismissed, restorable.
  const [dismissed, setDismissed] = useState<Array<{ id: string; matterId: string; ref: string; title: string | null; dismissedAt: string; dismissedBy: string | null; matterRef: string | null; propertyAddress: string | null }>>([]);
  const [showDismissed, setShowDismissed] = useState(false);
  const [disSort, setDisSort] = useState<'newest' | 'oldest' | 'case'>('newest');
  const [disBy, setDisBy] = useState('');
  const loadDismissed = useCallback(() => { api<{ dismissed: typeof dismissed }>('/tasks/dismissed').then((r) => setDismissed(r.dismissed)).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadDismissed(); }, [loadDismissed]);
  const dismiss = async (i: WorkItem) => {
    const key = i.ref?.id;
    if (!key) return;
    markDone(key);
    try { await api('/tasks/dismissed', { method: 'POST', body: JSON.stringify({ matterId: i.matterId, ref: `${i.ref.type}:${i.ref.id}`, title: sentence(i.what) }) }); loadDismissed(); window.dispatchEvent(new Event('conveyi:counts')); }
    catch (e: unknown) { setDone((cur) => { const n = new Map(cur); n.delete(key); return n; }); setQuickErr({ id: key, text: e instanceof Error ? e.message : 'Could not dismiss it.' }); }
  };
  const restore = async (id: string) => {
    setDismissed((cur) => cur.filter((d) => d.id !== id));
    await api('/tasks/dismissed', { method: 'POST', body: JSON.stringify({ restore: id }) }).catch(() => {});
    void load(); loadDismissed(); window.dispatchEvent(new Event('conveyi:counts'));
  };
  // Dismissed: the search above narrows it too; newest first unless sorted otherwise.
  const dismissedShown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return dismissed
      .filter((d) => (!disBy || d.dismissedBy === disBy) && words.every((w) => `${d.title ?? ''} ${d.propertyAddress ?? ''} ${d.matterRef ?? ''}`.toLowerCase().includes(w)))
      .sort((a, b) => disSort === 'case' ? (a.propertyAddress ?? a.matterRef ?? '').localeCompare(b.propertyAddress ?? b.matterRef ?? '') : disSort === 'oldest' ? a.dismissedAt.localeCompare(b.dismissedAt) : b.dismissedAt.localeCompare(a.dismissedAt));
  }, [dismissed, q, disSort, disBy]);
  /** Every word typed matches the case (address, reference, clients) or the task itself. */
  const matches = useCallback((i: WorkItem) => { const hay = `${i.propertyAddress ?? ''} ${i.matterRef ?? ''} ${(i.clients ?? []).join(' ')} ${i.what} ${i.chip ?? ''}`.toLowerCase(); return q.trim().toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w)); }, [q]);
  const [open, setOpen] = useState<string | null>(null);
  // Cases folded away, remembered in this browser.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  useEffect(() => { try { setFolded(new Set(JSON.parse(localStorage.getItem('tl-folded') ?? '[]') as string[])); } catch { /* storage blocked */ } }, []);
  const toggleFold = (id: string) => setFolded((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); try { localStorage.setItem('tl-folded', JSON.stringify([...n])); } catch { /* storage blocked */ } return n; });
  // Several approvals can be in flight at once; each row tracks its own.
  const [approving, setApproving] = useState<Set<string>>(new Set());
  const busyOn = (id: string, on: boolean) => setApproving((cur) => { const n = new Set(cur); if (on) n.add(id); else n.delete(id); return n; });
  /** Tasks dealt with here: hidden at once, and kept hidden until a fresh list no longer has them (a slow reload cannot bring one back). */
  const [done, setDone] = useState<Map<string, number>>(new Map());
  const markDone = (id: string) => setDone((cur) => new Map(cur).set(id, Date.now()));
  const loadSeq = useRef(0);
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
  const quickApprove = async (_key: string, eventId: string) => {
    busyOn(eventId, true);
    setQuickErr(null);
    markDone(eventId);
    try { await api(`/decisions/${eventId}/resolve`, { method: 'POST', body: JSON.stringify({ option: 'approve' }) }); void load(); }
    catch (e: unknown) {
      if ((e as { status?: number }).status !== 409) {
        setDone((cur) => { const n = new Map(cur); n.delete(eventId); return n; });
        setQuickErr({ id: eventId, text: e instanceof Error ? e.message : 'Could not approve.' });
      }
    }
    finally { busyOn(eventId, false); }
  };
  const load = useCallback(async () => {
    // Only the newest reload is applied: an older, slower one landing after it cannot put things back.
    const mine = ++loadSeq.current;
    try {
      const fresh = await api<{ do: WorkItem[]; waiting: WorkItem[]; escalate: WorkItem[]; viewerRole?: string }>(who ? `/engine/my-work?user=${who}` : '/engine/my-work?all=1');
      if (mine !== loadSeq.current) return;
      setData(fresh); setCheckedAt(new Date());
      // Forget what the server no longer lists (or after two minutes, whatever it says).
      const ids = new Set([...fresh.do, ...fresh.escalate].map((i) => i.ref?.id).filter(Boolean) as string[]);
      setDone((cur) => { const n = new Map([...cur].filter(([id, at]) => ids.has(id) && Date.now() - at < 120_000)); return n.size === cur.size ? cur : n; });
    } catch { /* a failed reload keeps the list as it was */ }
  }, [who]);
  useEffect(() => { void load(); }, [load]);
  // The Refresh beside the heading asks the list to reload in place; it says when it is done.
  useEffect(() => {
    const on = (e: Event) => { void load().finally(() => (e as CustomEvent<{ done?: () => void }>).detail?.done?.()); };
    window.addEventListener('conveyi:refresh-tasks', on);
    return () => window.removeEventListener('conveyi:refresh-tasks', on);
  }, [load]);

  const now = Date.now();
  const tasks = useMemo(() => {
    if (!data) return [];
    const all = [...data.do, ...data.escalate].filter((i) => !(i.ref?.id && done.has(i.ref.id)));
    const filtered = all.filter(matches);
    const by: Record<Sort, (a: WorkItem, b: WorkItem) => number> = {
      urgency: (a, b) => (RANK[a.urgency] ?? 9) - (RANK[b.urgency] ?? 9) || (ageDays(b, now) ?? 0) - (ageDays(a, now) ?? 0),
      due: (a, b) => (dueIn(a, now) ?? ageDays(a, now) == null ? 9999 : -(ageDays(a, now) ?? 0)) - (dueIn(b, now) ?? ageDays(b, now) == null ? 9999 : -(ageDays(b, now) ?? 0)),
      case: (a, b) => (a.propertyAddress ?? a.matterRef ?? '').localeCompare(b.propertyAddress ?? b.matterRef ?? '') || (RANK[a.urgency] ?? 9) - (RANK[b.urgency] ?? 9),
    };
    return filtered.slice().sort(by[sort]);
  }, [data, matches, sort, now, done]);

  // Grouped by case, in the order the sort puts their first task.
  const groups = useMemo(() => {
    const m = new Map<string, { matterId: string; address: string; ref: string | null; clients: string[]; band: string; items: WorkItem[] }>();
    for (const i of tasks) {
      const g = m.get(i.matterId) ?? { matterId: i.matterId, address: i.propertyAddress ?? i.matterRef ?? 'Case', ref: i.matterRef, clients: i.clients ?? [], band: i.caseBand ?? i.urgency, items: [] };
      g.items.push(i);
      if (!i.caseBand && (RANK[i.urgency] ?? 9) < (RANK[g.band] ?? 9)) g.band = i.urgency;
      m.set(i.matterId, g);
    }
    return Array.from(m.values());
  }, [tasks]);

  if (!data) return null;
  return (
    <div>
      <style>{WORK_CSS + CSS}</style>
      <div className="tl-bar">
        <label>Sort<select value={sort} onChange={(e) => setSort(e.target.value as Sort)}><option value="urgency">Urgency</option><option value="due">Due Date</option><option value="case">Case</option></select></label>
        <div className="tl-q"><Search size={16} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cases, clients or tasks" aria-label="Search tasks" /></div>
        <span className="n">{tasks.length} task{tasks.length === 1 ? '' : 's'}{groups.length > 1 ? ` across ${groups.length} cases` : ''}</span>
      </div>
      {outcome && <div className={`tl-out${outcome.ok ? '' : ' warn'}`} role="status">{outcome.text}</div>}
      {tasks.length === 0 && checkedAt && (
        <div className="tl-clear"><CheckCircle size={16} /><span>All clear</span><span className="t">checked {checkedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span></div>
      )}
      {groups.length > 0 && <div className="tl-groups">
      {groups.map((g) => (
        <div key={g.matterId} className="tl-group">
          <div className="tl-case" role="button" tabIndex={0} aria-expanded={!folded.has(g.matterId)} onClick={() => toggleFold(g.matterId)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFold(g.matterId); } }}>
            <span className={`chev${folded.has(g.matterId) ? '' : ' open'}`}><ChevronRight size={16} /></span>
            <House band={g.band as never} size={18} />
            <a href={paths.matter(g.matterId)} onClick={(e) => e.stopPropagation()}><b>{g.address}</b></a>
            {g.ref && <span className="ref">{g.ref}</span>}
            <span className="cnt">{g.items.length}</span>
            {g.clients.length > 0 && <span className="who">{g.clients.join(' & ')}</span>}
          </div>
          {!folded.has(g.matterId) && g.items.map((i) => {
            const isDecision = i.ref?.type === 'decision';
            const isStep = i.ref?.type === 'step';
            const isIssue = i.ref?.type === 'issue';
            const key = `${i.matterId}:${i.id}`;
            const isOpen = open === key;
            const due = dueIn(i, now);
            return (
              <div key={key} className={`tl-item${isOpen ? ' open' : ''}`}>
                <div className="tl-task">
                  <div>
                    <div className="what">{i.kind && <span className={`tl-chip${i.kind.startsWith('proposal') ? ' prop' : ''}`}>{i.chip ?? chipLabel(i.kind)}</span>}{sentence(i.what)}</div>
                    {quickErr?.id === i.ref?.id && <div className="sub" style={{ color: '#b91c1c' }}>{quickErr.text}</div>}
                    {(i.unblocks || i.bucket === 'escalate') && <div className="sub">{i.bucket === 'escalate' ? 'Escalated: writing again will not fix it' : `Unblocks ${i.unblocks!.toLowerCase()}`}</div>}
                  </div>
                  <span className={`age${due != null && due < 0 ? ' over' : due != null && due <= 2 ? ' soon' : ''}`}>{due != null ? (due < 0 ? `${-due}d overdue` : due === 0 ? 'due today' : `due in ${due}d`) : i.since ? stamp(i.since) : ''}</span>
                  <span className="tl-acts">
                  {isDecision && forConveyancer(i) && <span className="tl-for">For A Conveyancer</span>}
                  {isDecision && !forConveyancer(i) && quickApprovable(i.kind) && !isOpen && <button type="button" className="tl-btn go" disabled={approving.has(i.ref.id)} onClick={() => void quickApprove(key, i.ref.id)}>{approving.has(i.ref.id) ? 'Approving…' : 'Approve'}</button>}
                  {isDecision || isStep
                    ? <button type="button" className={`tl-btn${isOpen ? ' on' : ''}`} aria-label={isOpen ? 'Collapse' : 'Review'} onClick={() => setOpen(isOpen ? null : key)}>{isOpen ? null : 'Review '}<ChevronRight size={14} style={{ transform: isOpen ? 'rotate(90deg)' : undefined }} /></button>
                    : <>
                      {i.kind === 'issue:file_locked' && i.documentId && (unlockingId === i.id
                        ? <span className="tl-pw"><PasswordInput autoFocus value={pwd} onChange={setPwd} onEnter={() => void unlock(i)} onEscape={() => setUnlockingId(null)} style={{ width: 190 }} /><button type="button" className="tl-btn go" disabled={!pwd || unlockBusy} onClick={() => void unlock(i)}>{unlockBusy ? 'Unlocking…' : 'Unlock'}</button></span>
                        : <button type="button" className="tl-btn go" onClick={() => { setUnlockingId(i.id); setPwd(''); }}>Enter Password</button>)}
                      {i.kind === 'issue:send_failed:retry' && <button type="button" className="tl-btn go" disabled={retrying === i.ref.id} onClick={() => void retry(i.matterId, i.ref.id)}>{retrying === i.ref.id ? 'Sending…' : 'Try Again'}</button>}
                      {isIssue
                        ? <button type="button" className={`tl-btn${isOpen ? ' on' : ''}`} aria-label={isOpen ? 'Collapse' : 'Review'} onClick={() => setOpen(isOpen ? null : key)}>{isOpen ? null : 'Review '}<ChevronRight size={14} style={{ transform: isOpen ? 'rotate(90deg)' : undefined }} /></button>
                        : <a className="tl-btn" href={paths.matter(i.matterId)}>Open Case <ChevronRight size={14} /></a>}
                    </>}
                  <button type="button" className="tl-x" title="Dismiss (restore it from Dismissed)" aria-label="Dismiss" onClick={() => void dismiss(i)}><X size={16} /></button>
                  </span>
                </div>
                {isOpen && isDecision && (
                  <div className="tl-open">
                    <DecisionPanel eventId={i.ref.id} inline onResolved={() => { markDone(i.ref.id); setOpen((cur) => (cur === key ? null : cur)); void load(); }} />
                  </div>
                )}
                {isOpen && isIssue && (
                  <div className="tl-open tl-step">
                    <IssueReview api={api} matterId={i.matterId} issueId={i.ref.id} onDone={() => { markDone(i.ref.id); setOpen((cur) => (cur === key ? null : cur)); void load(); }} />
                  </div>
                )}
                {isOpen && isStep && (
                  <div className="tl-open tl-step">
                    <StepReview api={api} matterId={i.matterId} stepKey={i.ref.id} onDone={() => { markDone(i.ref.id); setOpen((cur) => (cur === key ? null : cur)); void load(); }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      </div>}
      {data.waiting.length > 0 && <Waiting items={data.waiting.filter(matches)} total={data.waiting.length} onChanged={() => void load()} />}
      {dismissed.length > 0 && (
        <div className="tl-dis">
          <button type="button" onClick={() => setShowDismissed((v) => !v)} aria-expanded={showDismissed}><ChevronRight size={16} style={{ transform: showDismissed ? 'rotate(90deg)' : undefined }} />Dismissed<span className="n">{dismissedShown.length !== dismissed.length ? `${dismissedShown.length} of ${dismissed.length}` : dismissed.length}</span></button>
          {showDismissed && (
            <div className="tl-dis-tools">
              <label>Sort<select value={disSort} onChange={(e) => setDisSort(e.target.value as typeof disSort)}><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="case">Case</option></select></label>
              <label>Dismissed By<select value={disBy} onChange={(e) => setDisBy(e.target.value)}><option value="">Anyone</option>{[...new Set(dismissed.map((d) => d.dismissedBy).filter((x): x is string => !!x))].sort().map((b) => <option key={b} value={b}>{b}</option>)}</select></label>
            </div>
          )}
          {showDismissed && dismissedShown.map((d) => (
            <div key={d.id} className="tl-dis-row">
              <span className="t">{d.title ?? d.ref}</span>
              <span className="m">{d.propertyAddress ?? d.matterRef ?? ''}</span>
              <span className="m">{stamp(d.dismissedAt)}{d.dismissedBy ? ` · ${d.dismissedBy}` : ''}</span>
              <button type="button" className="tl-btn" onClick={() => void restore(d.id)}>Restore</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
