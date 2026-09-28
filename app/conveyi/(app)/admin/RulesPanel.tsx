'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ChevronRight } from '@/app/shared/icons';

type Status = 'approved' | 'change_proposed' | 'changed_since' | 'not_reviewed';
type Rule = { id: string; stage: string; source: 'email' | 'document' | 'timer'; signal: string; detects: string; from?: string; actions: string[]; decides: string; holds?: string; code: string[]; status: Status; proposal: string | null; reviewedBy: string | null; reviewedAt: string | null };

const SOURCE_TAG: Record<Rule['source'], string> = { email: 'Email', document: 'Document', timer: 'Timer' };
const STAGES = ['Instruction', 'Source Of Funds', 'Searches', 'Title And Contract', 'Enquiries', 'Survey', 'Mortgage', 'Leasehold', 'Exchange', 'Signing And Completion', 'After Completion', 'Throughout'];
type Options = { sources: Record<string, string>; senders: Record<string, string>; decides: Record<string, string>; holds: Record<string, string> };
type Proposal = { id: string; signal: string; sources: string[]; senders: string[]; example: string | null; actions: string; decides: string; holds: string; proposedBy: string | null; proposedAt: string };
const BLANK = { signal: '', sources: [] as string[], senders: [] as string[], example: '', actions: '', decides: 'fee_earner', holds: 'nothing' };
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
.pb-src{font-size:10.5px;font-weight:700;color:#64748b;border:1px solid #e2e8f0;border-radius:99px;padding:1px 7px}
.pb-sel{border:1px solid #cbd5e1;border-radius:8px;padding:6px 8px;font:inherit;font-size:12.5px;background:#fff}
.pb-veil{position:fixed;inset:0;background:rgba(15,23,42,.38);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:56px 16px 16px;overflow-y:auto}
.pb-dlg{background:#fff;border-radius:14px;width:100%;max-width:640px;box-shadow:0 24px 64px rgba(15,23,42,.24);padding:18px 20px;display:grid;gap:12px}
.pb-dlg h2{margin:0;font-size:16px;font-weight:800}
.pb-f{display:grid;gap:5px;font-size:12px;font-weight:700;color:#475569}
.pb-f input,.pb-f select{border:1px solid #cbd5e1;border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;font-weight:400}
.pb-checks{display:flex;flex-wrap:wrap;gap:6px}
.pb-checks label{display:flex;align-items:center;gap:6px;border:1px solid #e2e8f0;border-radius:8px;padding:5px 9px;font-size:12.5px;font-weight:500;color:#334155;cursor:pointer}
.pb-checks label.on{border-color:#c4b5fd;background:#f5f3ff}
.pb-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media (max-width:560px){.pb-row2{grid-template-columns:1fr}}
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
  const [source, setSource] = useState<Rule['source'] | 'all'>('all');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [opts, setOpts] = useState<Options | null>(null);
  const [adding, setAdding] = useState(false);
  const [nr, setNr] = useState(BLANK);
  const take = (r: { rules: Rule[]; proposals?: Proposal[]; options?: Options }) => { setRules(r.rules); if (r.proposals) setProposals(r.proposals); if (r.options) setOpts(r.options); };
  useEffect(() => { api<{ rules: Rule[]; proposals: Proposal[]; options: Options }>('/admin/rules').then(take).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the rules.')); }, []);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (rules ?? []).filter((r) => (filter === 'all' || r.status === filter) && (source === 'all' || r.source === source) && (!n || `${r.signal} ${r.detects} ${r.actions.join(' ')}`.toLowerCase().includes(n)));
  }, [rules, q, filter, source]);

  if (err && !rules) return <div className="eg-err">{err}</div>;
  if (!rules) return <div className="eg-sub">Loading…</div>;
  const count = (s: Status) => rules.filter((r) => r.status === s).length;
  const review = async (ruleId: string, status: 'approved' | 'change_proposed', proposal: string | null = null) => {
    setBusy(true); setErr(null);
    try { take(await api<{ rules: Rule[]; proposals: Proposal[] }>('/admin/rules', { method: 'POST', body: JSON.stringify({ ruleId, status, proposal }) })); setDrafting(null); setDraft(''); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };

  const submitNew = async () => {
    setBusy(true); setErr(null);
    try { take(await api('/admin/rules', { method: 'PUT', body: JSON.stringify({ ...nr, example: nr.example.trim() || null }) })); setAdding(false); setNr(BLANK); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };
  const removeNew = async (id: string) => {
    if (!window.confirm('Remove this proposed rule?')) return;
    try { take(await api(`/admin/rules?id=${id}`, { method: 'DELETE' })); } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not remove it.'); }
  };
  const toggle = (k: 'sources' | 'senders', v: string) => setNr((cur) => ({ ...cur, [k]: cur[k].includes(v) ? cur[k].filter((x) => x !== v) : [...cur[k], v] }));
  const needsSender = nr.sources.some((x) => x === 'email_body' || x === 'attachment' || x === 'call_note');

  return (
    <div className="pb">
      <style>{CSS}</style>
      <div className="pb-top">
        <span className="n">{rules.length} rules · {count('approved')} approved · {count('change_proposed')} change{count('change_proposed') === 1 ? '' : 's'} proposed · {count('not_reviewed') + count('changed_since')} to review</span>
        {FILTERS.map(([k, l]) => <button key={k} type="button" className={`pb-chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}
        <select className="pb-sel" value={source} onChange={(e) => setSource(e.target.value as typeof source)} aria-label="Where it comes from">
          <option value="all">Any Source</option><option value="email">Email</option><option value="document">Documents</option><option value="timer">Timers</option>
        </select>
        <input className="pb-in" placeholder="Search the rules" value={q} onChange={(e) => setQ(e.target.value)} />
        {canPropose && <button className="pb-btn" onClick={() => setAdding(true)}>Propose New Rule</button>}
        <a className="pb-btn" href="/api/v1/admin/rules/export">Export Proposals</a>
      </div>
      {err && <div className="pb-err">{err}</div>}
      {proposals.length > 0 && (
        <div className="pb-grp">
          <h3>Proposed New Rules</h3>
          <div className="pb-list">
            {proposals.map((p) => (
              <div key={p.id} className={`pb-r${open === p.id ? ' open' : ''}`}>
                <button type="button" className="pb-h" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
                  <b>{p.signal}</b><span className="pb-st chg">New</span><span className="chev"><ChevronRight size={16} /></span>
                </button>
                {open === p.id && opts && (
                  <div className="pb-b">
                    <div className="pb-kv">
                      <span>Comes From</span><span>{p.sources.map((x) => opts.sources[x] ?? x).join('; ')}</span>
                      {p.senders.length > 0 && <><span>From</span><span>{p.senders.map((x) => opts.senders[x] ?? x).join('; ')}</span></>}
                      <span>Then</span><span style={{ whiteSpace: 'pre-wrap' }}>{p.actions}</span>
                      <span>Decides</span><span>{opts.decides[p.decides] ?? p.decides}</span>
                      <span>Holds</span><span>{opts.holds[p.holds] ?? p.holds}</span>
                      {p.example && <><span>Example</span><span style={{ whiteSpace: 'pre-wrap' }}>{p.example}</span></>}
                    </div>
                    <div className="pb-acts"><span className="pb-code">Proposed by {p.proposedBy ?? 'the firm'} on {new Date(p.proposedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span><button className="pb-btn" onClick={() => void removeNew(p.id)}>Remove</button></div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {STAGES.map((stage) => {
        const list = shown.filter((r) => r.stage === stage);
        if (!list.length) return null;
        return (
          <div key={stage} className="pb-grp">
            <h3>{stage}</h3>
            <div className="pb-list">
              {list.map((r) => {
                const isOpen = open === r.id;
                return (
                  <div key={r.id} className={`pb-r${isOpen ? ' open' : ''}`}>
                    <button type="button" className="pb-h" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}>
                      <b>{r.signal}</b><span className="pb-src">{SOURCE_TAG[r.source]}</span><span className={`pb-st ${CHIP[r.status].cls}`}>{CHIP[r.status].label}</span><span className="chev"><ChevronRight size={16} /></span>
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
      {adding && opts && (
        <div className="pb-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) setAdding(false); }}>
          <div className="pb-dlg" role="dialog" aria-label="Propose New Rule">
            <h2>Propose New Rule</h2>
            <label className="pb-f">What should the system notice?<input value={nr.signal} onChange={(e) => setNr({ ...nr, signal: e.target.value })} placeholder="e.g. The seller's solicitor says the seller has died" autoFocus /></label>
            <div className="pb-f">Where can it come from?
              <div className="pb-checks">{Object.entries(opts.sources).map(([k, l]) => <label key={k} className={nr.sources.includes(k) ? 'on' : ''}><input type="checkbox" checked={nr.sources.includes(k)} onChange={() => toggle('sources', k)} />{l}</label>)}</div>
            </div>
            {needsSender && (
              <div className="pb-f">Who can it come from?
                <div className="pb-checks">{Object.entries(opts.senders).map(([k, l]) => <label key={k} className={nr.senders.includes(k) ? 'on' : ''}><input type="checkbox" checked={nr.senders.includes(k)} onChange={() => toggle('senders', k)} />{l}</label>)}</div>
              </div>
            )}
            <label className="pb-f">What should happen?<textarea className="pb-ta" rows={4} value={nr.actions} onChange={(e) => setNr({ ...nr, actions: e.target.value })} placeholder="One step per line: what the system records, who it tells, what it drafts" /></label>
            <div className="pb-row2">
              <label className="pb-f">Who decides?<select value={nr.decides} onChange={(e) => setNr({ ...nr, decides: e.target.value })}>{Object.entries(opts.decides).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
              <label className="pb-f">Should it hold anything?<select value={nr.holds} onChange={(e) => setNr({ ...nr, holds: e.target.value })}>{Object.entries(opts.holds).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            </div>
            <label className="pb-f">An example of what it looks like (optional)<textarea className="pb-ta" rows={3} value={nr.example} onChange={(e) => setNr({ ...nr, example: e.target.value })} placeholder="Paste the kind of email wording or document that should trigger it" /></label>
            {err && <div className="pb-err">{err}</div>}
            <div className="pb-acts" style={{ justifyContent: 'flex-end' }}>
              <button className="pb-btn" onClick={() => setAdding(false)}>Cancel</button>
              <button className="pb-btn go" disabled={busy || nr.signal.trim().length < 5 || !nr.sources.length || nr.actions.trim().length < 5 || (needsSender && !nr.senders.length)} onClick={() => void submitNew()}>Save Proposal</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
