'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ChevronRight } from '@/app/shared/icons';

type Status = 'approved' | 'change_proposed' | 'changed_since' | 'not_reviewed';
type Rule = { id: string; source: 'email' | 'document' | 'timer'; signal: string; detects: string; from?: string; actions: string[]; decides: string; holds?: string; code: string[]; status: Status; proposal: string | null; reviewedBy: string | null; reviewedAt: string | null };

const SOURCES: Array<[Rule['source'], string]> = [['email', 'From Email'], ['document', 'From Documents'], ['timer', 'From Timers']];
const CHIP: Record<Status, { label: string; cls: string }> = {
  approved: { label: 'Approved', cls: 'ok' },
  change_proposed: { label: 'Change Proposed', cls: 'chg' },
  changed_since: { label: 'Changed Since Approval', cls: 'warn' },
  not_reviewed: { label: 'Not Reviewed', cls: 'no' },
};
const FILTERS: Array<[Status | 'all', string]> = [['all', 'All'], ['not_reviewed', 'Not Reviewed'], ['change_proposed', 'Change Proposed'], ['changed_since', 'Changed'], ['approved', 'Approved']];

const CSS = `
.pb{display:grid;gap:12px}
.pb-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:10px 12px}
.pb-top .n{font-size:12.5px;color:#475569;margin-right:auto}
.pb-in{border:1px solid #cbd5e1;border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;min-width:220px}
.pb-chip{border:1px solid #e2e8f0;background:#fff;border-radius:999px;padding:4px 10px;font:inherit;font-size:12px;font-weight:700;color:#475569;cursor:pointer}
.pb-chip.on{background:#ede9fe;border-color:#c4b5fd;color:#5A27E0}
.pb-btn{border:1px solid #5A27E0;background:#fff;color:#5A27E0;border-radius:8px;padding:6px 12px;font-weight:700;font-size:12.5px;cursor:pointer;font-family:inherit;text-decoration:none;white-space:nowrap}
.pb-btn.go{background:#5A27E0;color:#fff}
.pb-btn:disabled{opacity:.6;cursor:default}
.pb-grp h3{margin:6px 0 8px;font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#64748b}
.pb-list{background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden}
.pb-r{border-top:1px solid #f1f5f9}
.pb-r:first-child{border-top:0}
.pb-h{display:flex;align-items:center;gap:10px;width:100%;border:0;background:none;padding:11px 14px;font:inherit;text-align:left;cursor:pointer}
.pb-h b{font-size:13.5px;color:#0f172a}
.pb-h .chev{margin-left:auto;color:#94a3b8;display:inline-flex;transition:transform .15s}
.pb-r.open .pb-h .chev{transform:rotate(90deg)}
.pb-st{font-size:10.5px;font-weight:800;border-radius:99px;padding:2px 8px;white-space:nowrap}
.pb-st.ok{background:#dcfce7;color:#166534}.pb-st.chg{background:#e0e7ff;color:#3730a3}.pb-st.warn{background:#fef3c7;color:#92400e}.pb-st.no{background:#f1f5f9;color:#64748b}
.pb-b{padding:0 14px 14px;display:grid;gap:8px;font-size:13px;color:#334155}
.pb-kv{display:grid;grid-template-columns:90px minmax(0,1fr);gap:4px 12px;line-height:1.5}
.pb-kv > span:nth-child(odd){font-size:11.5px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.03em;padding-top:2px}
.pb-kv ol{margin:0;padding-left:18px}
.pb-prop{background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:10px 12px;white-space:pre-wrap}
.pb-prop .by{display:block;font-size:11.5px;color:#4338ca;font-weight:700;margin-bottom:4px}
.pb-ta{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;resize:vertical}
.pb-acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pb-code{font-size:11.5px;color:#94a3b8}
.pb-err{color:#b91c1c;font-size:12.5px}
`;

/** The playbook: what the system detects and what it does, reviewed rule by rule. */
export function RulesPanel({ canApprove, canPropose }: { canApprove: boolean; canPropose: boolean }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Status | 'all'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ rules: Rule[] }>('/admin/rules').then((r) => setRules(r.rules)).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the rules.')); }, []);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (rules ?? []).filter((r) => (filter === 'all' || r.status === filter) && (!n || `${r.signal} ${r.detects} ${r.actions.join(' ')}`.toLowerCase().includes(n)));
  }, [rules, q, filter]);

  if (err && !rules) return <div className="eg-err">{err}</div>;
  if (!rules) return <div className="eg-sub">Loading…</div>;
  const count = (s: Status) => rules.filter((r) => r.status === s).length;
  const review = async (ruleId: string, status: 'approved' | 'change_proposed', proposal: string | null = null) => {
    setBusy(true); setErr(null);
    try { setRules((await api<{ rules: Rule[] }>('/admin/rules', { method: 'POST', body: JSON.stringify({ ruleId, status, proposal }) })).rules); setDrafting(null); setDraft(''); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="pb">
      <style>{CSS}</style>
      <div className="pb-top">
        <span className="n">{rules.length} rules · {count('approved')} approved · {count('change_proposed')} change{count('change_proposed') === 1 ? '' : 's'} proposed · {count('not_reviewed') + count('changed_since')} to review</span>
        {FILTERS.map(([k, l]) => <button key={k} type="button" className={`pb-chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}
        <input className="pb-in" placeholder="Search the rules" value={q} onChange={(e) => setQ(e.target.value)} />
        <a className="pb-btn" href="/api/v1/admin/rules/export" aria-disabled={!count('change_proposed')}>Export Proposed Changes</a>
      </div>
      {err && <div className="pb-err">{err}</div>}
      {SOURCES.map(([src, label]) => {
        const list = shown.filter((r) => r.source === src);
        if (!list.length) return null;
        return (
          <div key={src} className="pb-grp">
            <h3>{label}</h3>
            <div className="pb-list">
              {list.map((r) => {
                const isOpen = open === r.id;
                return (
                  <div key={r.id} className={`pb-r${isOpen ? ' open' : ''}`}>
                    <button type="button" className="pb-h" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}>
                      <b>{r.signal}</b><span className={`pb-st ${CHIP[r.status].cls}`}>{CHIP[r.status].label}</span><span className="chev"><ChevronRight size={16} /></span>
                    </button>
                    {isOpen && (
                      <div className="pb-b">
                        <div className="pb-kv">
                          <span>Detects</span><span>{r.detects}</span>
                          {r.from && <><span>From</span><span>{r.from}</span></>}
                          <span>Then</span><ol>{r.actions.map((a, i) => <li key={i}>{a}</li>)}</ol>
                          <span>Decides</span><span>{r.decides}</span>
                          {r.holds && <><span>Holds</span><span>{r.holds}</span></>}
                        </div>
                        {r.status === 'change_proposed' && r.proposal && drafting !== r.id && <div className="pb-prop"><span className="by">Proposed by {r.reviewedBy ?? 'the firm'}{r.reviewedAt ? ` on ${new Date(r.reviewedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</span>{r.proposal}</div>}
                        {r.status === 'approved' && r.reviewedBy && <div className="pb-code">Approved by {r.reviewedBy}{r.reviewedAt ? ` on ${new Date(r.reviewedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</div>}
                        {drafting === r.id ? (
                          <>
                            <textarea className="pb-ta" rows={4} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What should happen instead?" />
                            <div className="pb-acts">
                              <button className="pb-btn go" disabled={busy || !draft.trim()} onClick={() => void review(r.id, 'change_proposed', draft)}>Save Proposal</button>
                              <button className="pb-btn" disabled={busy} onClick={() => setDrafting(null)}>Cancel</button>
                            </div>
                          </>
                        ) : (canApprove || canPropose) && (
                          <div className="pb-acts">
                            {canApprove && r.status !== 'approved' && <button className="pb-btn go" disabled={busy} onClick={() => void review(r.id, 'approved')}>Approve</button>}
                            {canPropose && <button className="pb-btn" disabled={busy} onClick={() => { setDrafting(r.id); setDraft(r.proposal ?? ''); }}>{r.status === 'change_proposed' ? 'Edit Proposal' : 'Propose Change'}</button>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
