'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtDay, pretty, type Api, type EngineState, type IssueCatalogue, type IssueRow } from './types';

/**
 * Issues on a case: what has gone wrong and what it holds. One row each, one action (Resolve)
 * and the rest under More. Context (who is running late) sits apart: it holds nothing, makes
 * no task, and is said in answers to "any update?". The catalogue comes from /engine/spec so
 * the panel never offers an outcome the machine would refuse.
 */
const gbp = (p: number) => `£${(p / 100).toLocaleString('en-GB')}`;
const clean = (s: string | null | undefined) => (s ?? '').replace(/\n?\[(proposal|retry):[^\]]*\]/g, '').replace(/\s*\[[a-z-]+:[^\]]*\]/g, '').trim();

const CSS = `
.is{display:grid;gap:10px}
.is-h{display:flex;align-items:center;gap:10px}
.is-h h3{margin:0;font-size:13px;font-weight:800;color:#0f172a;letter-spacing:.02em;text-transform:uppercase}
.is-h .n{font-size:12px;color:#64748b}
.is-h .sp{margin-left:auto}
.is-list{background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:visible}
.is-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:11px 14px;border-top:1px solid #f1f5f9;align-items:start}
.is-row:first-child{border-top:0}
.is-t{font-size:13.5px;font-weight:700;color:#0f172a;line-height:1.35}
.is-m{font-size:11.5px;color:#64748b;margin-top:2px}
.is-d{font-size:12.5px;color:#475569;margin-top:4px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.is-d.open{display:block}
.is-more-d{border:0;background:none;padding:0;font:inherit;font-size:11.5px;font-weight:700;color:#5A27E0;cursor:pointer}
.is-hold{display:inline-block;font-size:10.5px;font-weight:800;border-radius:99px;padding:1px 8px;margin-right:6px;vertical-align:1px;background:#fee2e2;color:#7f1d1d}
.is-hold.crit{background:#7f1d1d;color:#fff}
.is-acts{display:flex;gap:6px;align-items:center;position:relative}
.is-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:20;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 12px 32px rgba(15,23,42,.14);padding:4px;min-width:200px;display:grid}
.is-menu button{text-align:left;border:0;background:none;padding:7px 10px;border-radius:7px;font:inherit;font-size:13px;color:#0f172a;cursor:pointer}
.is-menu button:hover{background:#f5f3ff}
.is-menu button.bad{color:#b91c1c}
.is-menu hr{border:0;border-top:1px solid #f1f5f9;margin:3px 0}
.is-res{grid-column:1 / -1;display:grid;gap:8px;background:#f8fafc;border:1px solid #e6e8ee;border-radius:10px;padding:10px;margin-top:6px}
.is-res .r{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.is-res .fx{font-size:11.5px;color:#64748b}
.is-ctx .is-t{font-weight:600;color:#334155}
.is-empty{padding:12px 14px;font-size:12.5px;color:#64748b}
.is-closed{font-size:12px;color:#64748b}
.is-closed button{border:0;background:none;padding:0;font:inherit;font-size:12px;font-weight:700;color:#475569;cursor:pointer}
.is-closed div{padding:5px 0;border-top:1px solid #f1f5f9}
.is-veil{position:fixed;inset:0;background:rgba(15,23,42,.38);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:80px 16px 16px}
.is-dlg{background:#fff;border-radius:14px;width:100%;max-width:520px;box-shadow:0 24px 64px rgba(15,23,42,.24);padding:18px 20px;display:grid;gap:10px}
.is-dlg h2{margin:0;font-size:16px;font-weight:800}
.is-dlg label{display:grid;gap:4px;font-size:12px;font-weight:700;color:#475569}
.is-dlg .ep-input{width:100%;box-sizing:border-box}
.is-dlg textarea.ep-input{resize:vertical;font:inherit;font-size:13px}
.is-dlg .f{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
`;

export function IssuesPanel({ api, state, busy, cmd }: { api: Api; state: EngineState; busy: boolean; cmd: (body: Record<string, unknown>) => Promise<void> }) {
  const [cat, setCat] = useState<IssueCatalogue | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [unfold, setUnfold] = useState<Set<string>>(new Set());
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolution, setResolution] = useState('');
  const [note, setNote] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [cost, setCost] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [raising, setRaising] = useState(false);
  const [draft, setDraft] = useState({ kind: 'survey_defect', title: '', detail: '', gate: 'default' as 'default' | 'exchange' | 'completion' | 'none' });
  const [showClosed, setShowClosed] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { api<{ issues: IssueCatalogue }>('/engine/spec').then((s) => setCat(s.issues)).catch(() => setCat(null)); }, [api]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const kinds = useMemo(() => cat?.kinds ?? [], [cat]);
  const byKind = useMemo(() => Object.fromEntries(kinds.map((k) => [k.kind, k])), [kinds]);
  const isContext = (i: IssueRow) => !!byKind[i.kind]?.context || ['seller_delay', 'buyer_delay'].includes(i.kind);
  const all = Object.values(state.issues ?? {});
  const live = all.filter((i) => i.status === 'open' || i.status === 'negotiating').sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
  const open = live.filter((i) => !isContext(i));
  const context = live.filter(isContext);
  const closed = all.filter((i) => i.status === 'resolved' || i.status === 'fatal').sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));
  const exchanged = !!state.exchange.exchangedAt;
  const done = !!state.completion.confirmedAt || !!state.abandoned;

  const ask = (q: string, d = '') => window.prompt(q, d);
  const act = (body: Record<string, unknown>) => { setMenu(null); void cmd(body); };
  const del = (i: IssueRow) => { const r = ask('Delete this issue? It is taken off the case; the Timeline keeps the record. Why (optional)?'); if (r !== null) act({ type: 'withdraw_issue', issueId: i.id, reason: r.trim() || 'Deleted: not an issue.' }); };

  const startResolve = (i: IssueRow) => { setMenu(null); setResolving(i.id); setResolution(byKind[i.kind]?.resolutions[0] ?? 'other'); setNote(''); setNewPrice(''); setCost(''); setPaidBy(''); };
  const submitResolve = async (i: IssueRow) => {
    const body: Record<string, unknown> = { type: 'resolve_issue', issueId: i.id, resolution, note: note || null };
    if (resolution === 'price_reduced') body.newPricePennies = Math.round(Number(newPrice.replace(/[^0-9.]/g, '')) * 100);
    if (cost.trim()) { body.costPennies = Math.round(Number(cost.replace(/[^0-9.]/g, '')) * 100); body.paidBy = paidBy || null; }
    await cmd(body);
    setResolving(null);
  };
  const needsNote = resolution === 'other' || resolution === 'accepted_as_is';
  const resLabel = (r: string) => cat?.resolutions.find((x) => x.id === r)?.label ?? pretty(r);

  const row = (i: IssueRow, ctx: boolean) => {
    const k = byKind[i.kind];
    const detail = clean(i.detail);
    // The latest step, once there is one beyond the raise itself.
    const last = i.history.length > 1 ? i.history[i.history.length - 1] : null;
    const folded = !unfold.has(i.id);
    return (
      <div key={i.id} className={`is-row${ctx ? ' is-ctx' : ''}`}>
        <div style={{ minWidth: 0 }}>
          <div className="is-t">
            {!ctx && i.gate !== 'none' && <span className={`is-hold${i.severity === 'critical' ? ' crit' : ''}`}>Holds {i.gate === 'exchange' ? 'Exchange' : 'Completion'}</span>}
            {clean(i.title)}
          </div>
          <div className="is-m">{k?.label ?? pretty(i.kind)}{i.party ? ` · ${i.party}` : ''} · {fmtDay(i.raisedAt)}{i.status === 'negotiating' ? ' · negotiating' : ''}{i.enquiryIds?.length ? ` · enquiry ${i.enquiryIds.join(', ')}` : ''}{last && last.what !== i.title ? ` · ${last.what}` : ''}</div>
          {detail && <div className={`is-d${folded ? '' : ' open'}`}>{detail}</div>}
          {detail.length > 180 && <button type="button" className="is-more-d" onClick={() => setUnfold((cur) => { const n = new Set(cur); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n; })}>{folded ? 'Read More' : 'Show Less'}</button>}
        </div>
        {!done && (
          <div className="is-acts" ref={menu === i.id ? menuRef : undefined}>
            {!ctx && i.kind === 'send_failed' && /\[(proposal|retry):/.test(i.detail ?? '') && <button className="ep-btn primary" style={{ margin: 0 }} disabled={busy} onClick={() => act({ type: 'retry_issue', issueId: i.id })}>Try Again</button>}
            {!ctx && !(i.kind === 'send_failed' && /\[(proposal|retry):/.test(i.detail ?? '')) && <button className="ep-btn primary" style={{ margin: 0 }} disabled={busy} onClick={() => startResolve(i)}>Resolve</button>}
            {ctx && <button className="ep-btn" style={{ margin: 0 }} disabled={busy} onClick={() => act({ type: 'resolve_issue', issueId: i.id, resolution: k?.resolutions[0] ?? 'other', note: 'No longer the case.' })}>Clear</button>}
            <button className="ep-btn" style={{ margin: 0 }} disabled={busy} aria-haspopup="menu" aria-expanded={menu === i.id} onClick={() => setMenu(menu === i.id ? null : i.id)}>More</button>
            {menu === i.id && (
              <div className="is-menu" role="menu">
                <button role="menuitem" onClick={() => { const n = ask('Note'); if (n) act({ type: 'update_issue', issueId: i.id, status: i.status, note: n }); }}>Add Note</button>
                {!ctx && i.status === 'open' && <button role="menuitem" onClick={() => { const n = ask('What is happening? (e.g. "client asked for £10k off; agent relaying")'); if (n) act({ type: 'update_issue', issueId: i.id, status: 'negotiating', note: n }); }}>Mark Negotiating</button>}
                {!ctx && !exchanged && <button role="menuitem" onClick={() => { const q = ask('What do you want to ask the other side?'); if (q) act({ type: 'raise_enquiry', subject: q, origin: { issueId: i.id } }); }}>Ask The Other Side</button>}
                {!ctx && i.gate !== 'none' && <button role="menuitem" onClick={() => { const n = ask(`Release the hold on ${i.gate}? Say why (the client accepts the risk, the lender is content…). The issue stays open.`); if (n) act({ type: 'update_issue', issueId: i.id, status: i.status, gate: 'none', note: n }); }}>Release The Hold</button>}
                {!ctx && i.gate === 'none' && !exchanged && <button role="menuitem" onClick={() => { const n = ask('Hold exchange on this? Say why.'); if (n) act({ type: 'update_issue', issueId: i.id, status: i.status, gate: 'exchange', note: n }); }}>Hold Exchange</button>}
                {!ctx && i.severity !== 'critical' && <button role="menuitem" onClick={() => { const n = ask('Mark critical: why?'); if (n) act({ type: 'set_issue_severity', issueId: i.id, severity: 'critical', reason: n }); }}>Mark Critical</button>}
                <hr />
                <button role="menuitem" onClick={() => del(i)}>Delete</button>
                {!ctx && <button role="menuitem" className="bad" onClick={() => { const n = ask('This ends the transaction: the issue is marked fatal and the case abandoned. Say why.'); if (n && window.confirm('Abandon the case? This cannot be undone.')) act({ type: 'mark_issue_fatal', issueId: i.id, reason: n }); }}>Abandon The Case</button>}
              </div>
            )}
          </div>
        )}
        {resolving === i.id && (
          <div className="is-res">
            <div className="r">
              <select className="ep-input" value={resolution} onChange={(e) => setResolution(e.target.value)}>{(k?.resolutions ?? ['other']).map((r) => <option key={r} value={r}>{resLabel(r)}</option>)}</select>
              {resolution === 'price_reduced' && <input className="ep-input" placeholder="New price (£)" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} style={{ width: 130 }} />}
              <input className="ep-input" placeholder={needsNote ? 'Note (required)' : 'Note'} value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            </div>
            <div className="r">
              <input className="ep-input" placeholder="Cost of the fix (£, optional)" value={cost} onChange={(e) => setCost(e.target.value)} style={{ width: 190 }} />
              {cost.trim() && <select className="ep-input" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}><option value="">Paid by…</option>{['buyer', 'seller', 'shared', 'lender', 'other'].map((p) => <option key={p} value={p}>Paid by {p}</option>)}</select>}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button className="ep-btn" style={{ margin: 0 }} onClick={() => setResolving(null)}>Cancel</button>
                <button className="ep-btn primary" style={{ margin: 0 }} disabled={busy || (needsNote && !note.trim()) || (resolution === 'price_reduced' && !newPrice) || (!!cost.trim() && !paidBy)} onClick={() => void submitResolve(i)}>Resolve</button>
              </span>
            </div>
            {cat?.resolutions.find((x) => x.id === resolution)?.effects.length ? <div className="fx">Effect: {cat.resolutions.find((x) => x.id === resolution)!.effects.join('; ')}</div> : null}
          </div>
        )}
      </div>
    );
  };

  const sel = byKind[draft.kind];
  return (
    <div className="is">
      <style>{CSS}</style>
      <div className="is-h">
        <h3>Issues</h3>
        <span className="n">{open.length ? `${open.length} open${open.some((i) => i.gate !== 'none') ? ` · ${open.filter((i) => i.gate !== 'none').length} holding ${exchanged ? 'completion' : 'exchange'}` : ''}` : 'None open'}</span>
        {!done && <button className="ep-btn sp" style={{ margin: '0 0 0 auto' }} disabled={busy} onClick={() => setRaising(true)}>Raise Issue</button>}
      </div>
      <div className="is-list">{open.length ? open.map((i) => row(i, false)) : <div className="is-empty">Nothing is wrong on this case.</div>}</div>

      {context.length > 0 && (
        <>
          <div className="is-h"><h3>Context</h3></div>
          <div className="is-list">{context.map((i) => row(i, true))}</div>
        </>
      )}

      {closed.length > 0 && (
        <div className="is-closed">
          <button type="button" onClick={() => setShowClosed((x) => !x)}>{showClosed ? 'Hide' : 'Show'} {closed.length} Resolved</button>
          {showClosed && closed.map((i) => (
            <div key={i.id}><b>{clean(i.title)}</b>{i.resolution ? ` · ${resLabel(i.resolution)}` : ''}{i.resolvedAt ? ` · ${fmtDay(i.resolvedAt)}` : ''}{i.costPennies != null ? ` · ${gbp(i.costPennies)}${i.paidBy ? ` paid by ${i.paidBy}` : ''}` : ''}</div>
          ))}
        </div>
      )}

      {raising && (
        <div className="is-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) setRaising(false); }}>
          <div className="is-dlg" role="dialog" aria-label="Raise Issue">
            <h2>Raise Issue</h2>
            <label>Kind
              <select className="ep-input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value, gate: 'default' })}>
                {(cat?.groups ?? []).map((g) => (
                  <optgroup key={g.id} label={g.label}>{kinds.filter((k) => k.group === g.id && k.kind !== 'lender_approval').map((k) => <option key={k.kind} value={k.kind}>{k.label}{k.context ? ' (context)' : ''}</option>)}</optgroup>
                ))}
              </select>
            </label>
            <label>What is wrong<input className="ep-input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus /></label>
            <label>Detail<textarea className="ep-input" rows={3} value={draft.detail} onChange={(e) => setDraft({ ...draft, detail: e.target.value })} /></label>
            {!sel?.context && (
              <label>Holds
                <select className="ep-input" value={draft.gate} onChange={(e) => setDraft({ ...draft, gate: e.target.value as typeof draft.gate })}>
                  <option value="default">{sel ? `${sel.gate === 'none' ? 'Nothing' : sel.gate === 'exchange' && exchanged ? 'Completion' : sel.gate === 'exchange' ? 'Exchange' : 'Completion'} (usual for this kind)` : 'The usual for this kind'}</option>
                  {!exchanged && <option value="exchange">Exchange</option>}
                  <option value="completion">Completion</option>
                  <option value="none">Nothing</option>
                </select>
              </label>
            )}
            <div className="f">
              <button className="ep-btn" style={{ margin: 0 }} onClick={() => setRaising(false)}>Cancel</button>
              <button className="ep-btn primary" style={{ margin: 0 }} disabled={busy || !draft.title.trim()} onClick={() => { void cmd({ type: 'raise_issue', kind: draft.kind, title: draft.title.trim(), detail: draft.detail.trim() || null, gate: sel?.context ? 'none' : draft.gate === 'default' ? null : draft.gate }); setRaising(false); setDraft({ kind: draft.kind, title: '', detail: '', gate: 'default' }); }}>Raise Issue</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
