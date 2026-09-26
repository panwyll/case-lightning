'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { paths } from '@/lib/paths';
import { Paperclip, Check, X, Mail, AlertTriangle, Home } from '@/app/shared/icons';

/**
 * Filing email to cases (docs/email-filing.md).
 *
 * Not an inbox. One question per email — which case is this? — and the email leaves the
 * moment it is answered. The list on the left is what is left to file, each with its best
 * case; the right is the one email in hand: the cases it could be, what in it points to
 * each, and the email itself to read. Newsletters and notifications that match no case
 * sit in their own group, to set aside in one go.
 */
const CSS = `
.ef{display:grid;grid-template-columns:360px minmax(0,1fr);gap:14px;height:calc(100vh - 128px);min-height:420px}
.ef-head{display:flex;align-items:baseline;gap:10px;margin-bottom:12px}
.ef-mbox{margin-left:auto;border:1px solid #d0d5dd;border-radius:8px;padding:6px 10px;font:inherit;font-size:13px;background:#fff}
.ef-head .n{font-size:14px;font-weight:700;color:#94a3b8;font-variant-numeric:tabular-nums}
.ef-list{background:#fff;border:1px solid #e6e8ee;border-radius:14px;overflow:auto}
.ef-li{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid #f1f5f9;background:#fff;padding:10px 14px 10px 12px;cursor:pointer;font-family:inherit;color:inherit;border-left:3px solid transparent}
.ef-li:hover{background:#fafafa}
.ef-li.on{background:#f5f3ff;border-left-color:#5A27E0}
.ef-li .l1{display:flex;gap:8px;align-items:baseline;font-size:13px}
.ef-li .l1 b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#0f172a}
.ef-li .l1 .t{margin-left:auto;color:#94a3b8;font-size:11.5px;white-space:nowrap}
.ef-li .l2{font-size:12.5px;color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.ef-li .l3{display:flex;gap:6px;align-items:center;font-size:12px;color:#64748b;margin-top:4px;min-width:0}
.ef-li .l3 span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ef-li .dot{width:7px;height:7px;border-radius:99px;flex:0 0 auto}
.ef-li .warn{color:#dc2626;display:inline-flex}
.ef-more{display:block;width:100%;border:0;border-top:1px solid #f1f5f9;background:#fff;padding:10px;font-family:inherit;font-size:12px;font-weight:700;color:#5A27E0;cursor:pointer}
.ef-more:disabled{color:#94a3b8;cursor:default}
.ef-tabs{display:flex;align-items:center;gap:2px;border-bottom:1px solid #e8eaf0;background:#fff;padding:0 8px;position:sticky;top:0;z-index:1}
.ef-tabs .tab{display:flex;align-items:center;gap:7px;border:0;background:none;padding:10px 10px 9px;margin-bottom:-1px;border-bottom:2px solid transparent;font-family:inherit;cursor:pointer;color:#64748b;font-size:13px;font-weight:700}
.ef-tabs .tab.on{color:#0f172a;border-bottom-color:#5A27E0}
.ef-tabs .tab .c{font-size:11px;font-weight:800;font-variant-numeric:tabular-nums;color:#475569;background:#f1f5f9;border-radius:99px;padding:1px 7px}
.ef-tabs .tab.on .c{color:#5A27E0;background:#ede9fe}
.ef-tabs .aside{margin-left:auto;border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:4px 9px;font-size:12px;font-weight:700;color:#334155;cursor:pointer;font-family:inherit}
.ef-empty{padding:28px 14px;color:#94a3b8;font-size:13px;text-align:center}
.ef-li.muted .l1 b,.ef-li.muted .l2{color:#64748b}
.ef-pane{background:#fff;border:1px solid #e6e8ee;border-radius:14px;overflow:auto;display:flex;flex-direction:column}
.ef-top{padding:14px 18px 12px;border-bottom:1px solid #f1f5f9}
.ef-from{font-size:13px;color:#334155;display:flex;gap:6px;flex-wrap:wrap;align-items:baseline}
.ef-from b{color:#0f172a}
.ef-from .a,.ef-from .t{color:#94a3b8;font-size:12px}
.ef-from .t{margin-left:auto}
.ef-subj{font-size:17px;font-weight:800;margin:4px 0 0;color:#0f172a;letter-spacing:-.01em}
.ef-cases{display:grid;gap:8px;margin-top:12px}
.ef-case{display:grid;grid-template-columns:auto 1fr auto;gap:3px 12px;align-items:center;border:1px solid #e6e8ee;border-radius:12px;padding:10px 12px;background:#fff}
.ef-case.top{border-color:#c4b5fd;background:#faf8ff}
.ef-case .ic{color:#7c3aed;display:flex;grid-row:span 2;align-self:start;margin-top:2px}
.ef-case .addr{font-size:14px;font-weight:800;color:#0f172a;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.ef-case .ref{font-size:11px;font-weight:600;color:#94a3b8}
.ef-case .who{font-size:12.5px;color:#475569;grid-column:2}
.ef-case .side{grid-row:1 / span 2;grid-column:3;display:flex;gap:8px;align-items:center}
.ef-case ul{grid-column:2 / -1;list-style:none;margin:3px 0 0;padding:0;display:flex;gap:3px 14px;flex-wrap:wrap}
.ef-case li{display:inline-flex;gap:5px;align-items:center;font-size:12px;color:#166534}
.ef-case li.amber{color:#b45309}
.ef-pct{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:800;border-radius:99px;padding:2px 8px;font-variant-numeric:tabular-nums;white-space:nowrap}
.ef-pct i{width:7px;height:7px;border-radius:99px;display:inline-block}
.ef-file{display:inline-flex;gap:6px;align-items:center;border:1px solid #5A27E0;background:#5A27E0;color:#fff;border-radius:9px;padding:7px 12px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}
.ef-file.ghost{background:#fff;color:#5A27E0}
.ef-file:disabled{opacity:.5;cursor:not-allowed}
.ef-acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.ef-alt{border:1px solid #e2e8f0;background:#fff;border-radius:9px;padding:7px 11px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;color:#334155;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.ef-alt:hover{background:#f8fafc}
.ef-alt:disabled{opacity:.5;cursor:not-allowed}
.ef-warn{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;margin-top:10px;border:1px solid #fecaca;background:#fef2f2;color:#991b1b;border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.45}
.ef-warn b{font-size:13px}
.ef-pick{margin-top:10px;background:#f8fafc;border:1px solid #e6e8ee;border-radius:12px;padding:10px}
.ef-pick input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:13.5px;font-family:inherit;background:#fff}
.ef-hit{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;text-align:left;border:1px solid transparent;background:#fff;border-radius:9px;padding:8px 12px;font-size:13px;cursor:pointer;font-family:inherit;margin-top:6px;color:#0f172a}
.ef-hit:hover{border-color:#c4b5fd;background:#f5f3ff}
.ef-hit .who{display:block;font-size:12px;color:#64748b;margin-top:2px}
.ef-msg{flex:1;display:flex;flex-direction:column;min-height:260px}
.ef-meta{display:flex;gap:4px 16px;flex-wrap:wrap;padding:8px 18px;font-size:12px;color:#64748b;border-bottom:1px solid #f1f5f9}
.ef-meta b{color:#94a3b8;font-weight:600;margin-right:4px}
.ef-att{display:flex;gap:6px;flex-wrap:wrap;padding:8px 18px;border-bottom:1px solid #f1f5f9}
.ef-att span{display:inline-flex;align-items:center;gap:5px;font-size:12px;border:1px solid #e2e8f0;border-radius:8px;padding:3px 8px;color:#334155}
.ef-body{flex:1;width:100%;min-height:260px;border:0;background:#fff;display:block}
.ef-text{white-space:pre-wrap;font-size:13px;line-height:1.5;color:#334155;padding:12px 18px;margin:0;font-family:inherit}
.ef-done{text-align:center;padding:48px 16px;color:#64748b;background:#fff;border:1px solid #e6e8ee;border-radius:14px}
.ef-done b{display:block;font-size:19px;color:#0f172a;margin-bottom:6px}
@media (max-width:980px){.ef{grid-template-columns:1fr;height:auto}.ef-list{max-height:40vh}.ef-case{grid-template-columns:auto 1fr}.ef-case .side{grid-row:auto;grid-column:2}}
`;

/**
 * The matching engine's own verdict, as a percentage and a colour. Green is AUTO — a
 * linked thread, our reference, or two independent signals agree; amber is STRONG; red
 * is WEAK, worth a look before filing.
 */
const RAG: Record<string, { fg: string; bg: string; dot: string }> = {
  AUTO: { fg: '#166534', bg: '#dcfce7', dot: '#16a34a' },
  STRONG: { fg: '#92400e', bg: '#fef3c7', dot: '#d97706' },
  WEAK: { fg: '#991b1b', bg: '#fee2e2', dot: '#dc2626' },
};

interface CaseCard { matterId: string; matterRef: string; propertyAddress: string | null; type: string; clients: string[]; stage: string | null; handler: string | null; otherSide: string | null; closed: boolean }
interface Suggestion { matterId: string; matterRef: string; propertyAddress: string; band: string; score: number; case: CaseCard | null; matched: string[]; senderOnCase?: 'contact' | 'firm' | 'seen' | 'none' }
interface Person { name: string | null; address: string | null }
interface FullMessage { subject: string; from: Person | null; to: Person[]; cc: Person[]; receivedDateTime: string | null; body: { contentType: 'html' | 'text'; content: string }; attachments: Array<{ id: string; name: string; size: number }> }
interface Item {
  id: string;
  conversationId: string | null;
  subject: string;
  from: Person;
  receivedDateTime: string | null;
  bodyPreview: string;
  forwardedFrom?: string | null;
  notCaseMail?: string | null;
  hasAttachments: boolean;
  webLink: string | null;
  suggestions: Suggestion[];
  sender?: { verdict: 'ok' | 'unverified' | 'suspicious'; warnings: string[] };
}
interface MatterHit { id: string; matterRef: string; propertyAddress: string; case: CaseCard | null }

const person = (p: Person) => (p.name && p.address ? `${p.name} <${p.address}>` : p.name || p.address || '');
/** The email in a sandbox: no scripts, no remote content (tracking pixels stay unloaded). */
const shell = (html: string) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><base target="_blank"><style>body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1e293b;margin:12px 18px;overflow-wrap:anywhere}img{max-width:100%;height:auto}img:not([src^="data:"]){display:none}</style></head><body>${html}</body></html>`;
const when = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};
/** "Purchase for Priya Shah · Searches & enquiries · Alice Okafor" */
const describe = (c: CaseCard | null) =>
  c ? [`${c.type}${c.clients.length ? ` for ${c.clients.join(' & ')}` : ''}`, c.closed ? 'Closed' : c.stage, c.handler].filter(Boolean).join(' · ') : '';
const shortAddress = (s: Suggestion) => (s.case?.propertyAddress ?? s.propertyAddress ?? '').split(',').slice(0, 2).join(',');

function Pct({ s }: { s: Suggestion }) {
  const c = RAG[s.band] ?? RAG.WEAK;
  return <span className="ef-pct" style={{ color: c.fg, background: c.bg }}><i style={{ background: c.dot }} />{Math.round(s.score * 100)}%</span>;
}

export default function EmailToFile() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [noMailbox, setNoMailbox] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<'cases' | 'bulk'>('cases');
  const [totals, setTotals] = useState<{ toFile: number; bulk: number } | null>(null);
  const [mailboxes, setMailboxes] = useState<Array<{ userId: string; name: string; self: boolean }>>([]);
  const [mailbox, setMailbox] = useState<string | null>(null); // null = my own
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Item[]; nextCursor: string | null; toFile: number; bulk: number }>(`/mail/unfiled${mailbox ? `?mailbox=${mailbox}` : ''}`);
      setItems(r.items);
      setNextCursor(r.nextCursor);
      setTotals({ toFile: r.toFile, bulk: r.bulk });
      setSel((cur) => cur ?? r.items.find((i) => !i.notCaseMail)?.id ?? r.items[0]?.id ?? null);
      setErr(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not read your mailbox.';
      if (/graph account not connected/i.test(msg)) { setNoMailbox(true); setItems([]); } else setErr(msg);
    }
  }, [mailbox]);
  useEffect(() => { setItems(null); setSel(null); void load(); }, [load]);
  useEffect(() => { api<{ mailboxes: Array<{ userId: string; name: string; self: boolean }> }>('/mail/mailboxes').then((r) => setMailboxes(r.mailboxes)).catch(() => {}); }, []);

  /** The next page of the queue, appended. */
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api<{ items: Item[]; nextCursor: string | null; toFile: number; bulk: number }>(`/mail/unfiled?cursor=${encodeURIComponent(nextCursor)}${mailbox ? `&mailbox=${mailbox}` : ''}`);
      setItems((cur) => [...(cur ?? []), ...r.items.filter((i) => !(cur ?? []).some((c) => c.id === i.id))]);
      setNextCursor(r.nextCursor);
      setTotals({ toFile: r.toFile, bulk: r.bulk });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load more.');
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  const caseMail = useMemo(() => (items ?? []).filter((i) => !i.notCaseMail), [items]);
  const bulk = useMemo(() => (items ?? []).filter((i) => i.notCaseMail), [items]);
  const order = useMemo(() => (tab === 'cases' ? caseMail : bulk), [caseMail, bulk, tab]);
  const current = (items ?? []).find((i) => i.id === sel) ?? null;

  /** Take an email off the list and move on to the next one. */
  const retire = (ids: string[]) => {
    setItems((cur) => {
      const gone = (cur ?? []).filter((i) => ids.includes(i.id));
      setTotals((t) => t && { toFile: Math.max(0, t.toFile - gone.filter((i) => !i.notCaseMail).length), bulk: Math.max(0, t.bulk - gone.filter((i) => i.notCaseMail).length) });
      const next = (cur ?? []).filter((i) => !ids.includes(i.id));
      setSel((s) => {
        if (s && !ids.includes(s)) return s;
        const at = order.findIndex((i) => i.id === s);
        const rest = order.filter((i) => !ids.includes(i.id));
        return (rest[Math.min(Math.max(at, 0), rest.length - 1)] ?? next.find((i) => !i.notCaseMail) ?? next[0])?.id ?? null;
      });
      return next;
    });
  };
  const fileTo = async (item: Item, matterId: string) => {
    setBusy(true); setErr(null);
    try {
      await api(`/matters/${matterId}/link-thread`, { method: 'POST', body: JSON.stringify({ graphThreadId: item.conversationId ?? item.id, graphConversationId: item.conversationId ?? undefined, messageId: item.id, subject: item.subject, participants: [item.from.address].filter(Boolean), mailboxUserId: mailbox ?? undefined }) });
      retire([item.id]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not file that email.');
    } finally { setBusy(false); }
  };
  const setAside = async (list: Item[]) => {
    setBusy(true); setErr(null);
    try {
      for (const item of list) await api('/mail/not-a-case', { method: 'POST', body: JSON.stringify({ conversationId: item.conversationId ?? item.id, subject: item.subject, reason: item.notCaseMail ?? null, mailboxUserId: mailbox ?? undefined }) });
      retire(list.map((i) => i.id));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not set that aside.');
    } finally { setBusy(false); }
  };

  // Up / down (or j / k) moves through the list, as in any mail client.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return;
      const d = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
      if (!d || !order.length) return;
      e.preventDefault();
      const at = order.findIndex((i) => i.id === sel);
      setSel(order[Math.min(order.length - 1, Math.max(0, at + d))].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order, sel]);

  return (
    <div>
      <style>{CSS}</style>
      <div className="ef-head">
        <h1 className="eg-h1" style={{ margin: 0 }}>Email</h1>
        {mailboxes.length > 1 && (
          <select className="ef-mbox" value={mailbox ?? ''} onChange={(e) => setMailbox(e.target.value || null)} title="Whose mailbox to file from">
            {mailboxes.map((m) => <option key={m.userId} value={m.self ? '' : m.userId}>{m.name}</option>)}
          </select>
        )}
      </div>
      {err && <div className="eg-err">{err}</div>}
      {items === null && !err && !noMailbox && <div className="eg-sub">Loading…</div>}
      {noMailbox && (
        <div className="ef-done">
          <b>Mailbox not connected.</b>
          <div style={{ marginTop: 14 }}>
            <a className="eg-btn primary" href="/api/v1/auth/login?flow=web&consent=1">Connect Microsoft 365</a>{' '}
            <a className="eg-btn" href={paths.support}>What this can see</a>
          </div>
        </div>
      )}
      {items && !noMailbox && (
        <div className="ef">
          <div className="ef-list" role="listbox" aria-label="Email to file">
            <div className="ef-tabs" role="tablist">
              <button className={`tab${tab === 'cases' ? ' on' : ''}`} role="tab" aria-selected={tab === 'cases'} onClick={() => { setTab('cases'); setSel(caseMail[0]?.id ?? null); }}>
                Cases <span className="c">{totals?.toFile ?? caseMail.length}</span>
              </button>
              <button className={`tab${tab === 'bulk' ? ' on' : ''}`} role="tab" aria-selected={tab === 'bulk'} onClick={() => { setTab('bulk'); setSel(bulk[0]?.id ?? null); }}>
                Bulk <span className="c">{totals?.bulk ?? bulk.length}</span>
              </button>
              {tab === 'bulk' && bulk.length > 0 && <button className="aside" disabled={busy} onClick={() => void setAside(bulk)}>Set All Aside</button>}
            </div>
            {order.map((i) => <ListRow key={i.id} item={i} on={i.id === sel} onPick={() => setSel(i.id)} muted={tab === 'bulk'} />)}
            {order.length === 0 && <div className="ef-empty">{tab === 'cases' ? 'Nothing to file.' : 'No bulk mail.'}</div>}
            {nextCursor && (
              <button className="ef-more" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? 'Loading…' : 'Load More'}
              </button>
            )}
          </div>
          {current ? (
            <Detail key={current.id} item={current} mailbox={mailbox} busy={busy} onFile={(m) => fileTo(current, m)} onNotACase={() => setAside([current])} />
          ) : <div />}
        </div>
      )}
    </div>
  );
}

/** One email in the list: who, what, and the case it most looks like. */
function ListRow({ item, on, onPick, muted = false }: { item: Item; on: boolean; onPick: () => void; muted?: boolean }) {
  const top = item.suggestions[0];
  return (
    <button className={`ef-li${on ? ' on' : ''}${muted ? ' muted' : ''}`} onClick={onPick} role="option" aria-selected={on}>
      <div className="l1">
        {item.sender?.verdict === 'suspicious' && <span className="warn" title="Check this sender"><AlertTriangle size={13} /></span>}
        <b>{item.from.name ?? item.from.address ?? 'Unknown sender'}</b>
        <span className="t">{item.hasAttachments && <Paperclip size={11} />} {when(item.receivedDateTime)}</span>
      </div>
      <div className="l2">{item.subject || '(no subject)'}</div>
      {!muted && (
        <div className="l3">
          {top ? <><i className="dot" style={{ background: (RAG[top.band] ?? RAG.WEAK).dot }} /><span>{shortAddress(top)}{top.case?.clients.length ? ` · ${top.case.clients[0]}` : ''}</span></> : <span>No case found</span>}
        </div>
      )}
    </button>
  );
}

/** The email in hand: which case, why, and the email itself. */
function Detail({ item, mailbox, busy, onFile, onNotACase }: { item: Item; mailbox: string | null; busy: boolean; onFile: (matterId: string) => void; onNotACase: () => void }) {
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<MatterHit[]>([]);
  const [full, setFull] = useState<FullMessage | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<{ message: FullMessage }>(`/mail/message/${encodeURIComponent(item.id)}${mailbox ? `?mailbox=${mailbox}` : ''}`)
      .then((r) => { if (live) setFull(r.message); })
      .catch((e: unknown) => { if (live) setReadErr(e instanceof Error ? e.message : 'Could not open the email.'); });
    return () => { live = false; };
  }, [item.id, mailbox]);

  useEffect(() => {
    if (!picking || q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      try { setHits(((await api<{ matters: MatterHit[] }>(`/matters?q=${encodeURIComponent(q.trim())}`)).matters ?? []).slice(0, 6)); } catch { setHits([]); }
    }, 220);
    return () => clearTimeout(t);
  }, [picking, q]);

  return (
    <div className="ef-pane">
      <div className="ef-top">
        <div className="ef-from">
          <b>{item.from.name ?? item.from.address ?? 'Unknown sender'}</b>
          {item.from.name && item.from.address && <span className="a">{item.from.address}</span>}
          {item.forwardedFrom && <span className="a">· forwarded from {item.forwardedFrom}</span>}
          <span className="t">{when(item.receivedDateTime)}</span>
        </div>
        <h2 className="ef-subj">{item.subject || '(no subject)'}</h2>

        {item.sender?.verdict === 'suspicious' && (
          <div className="ef-warn" role="alert">
            <AlertTriangle size={16} />
            <b>Check this sender before acting on it</b>
            <span />
            <span>{item.sender.warnings.join(' ')} The sender has not been counted towards matching a case.</span>
          </div>
        )}

        {item.suggestions.length > 0 && (
          <div className="ef-cases">
            {item.suggestions.map((s, i) => (
              <div key={s.matterId} className={`ef-case${i === 0 ? ' top' : ''}`}>
                <span className="ic"><Home size={16} /></span>
                <span className="addr">{s.case?.propertyAddress ?? s.propertyAddress}<span className="ref">{s.matterRef}</span></span>
                <span className="side"><Pct s={s} /><button className={`ef-file${i === 0 && item.sender?.verdict !== 'suspicious' ? '' : ' ghost'}`} disabled={busy} onClick={() => onFile(s.matterId)}><Check size={13} /> File here</button></span>
                <span className="who">{describe(s.case)}{s.case?.otherSide ? ` · other side ${s.case.otherSide}` : ''}</span>
                {(s.matched.length > 0 || s.senderOnCase === 'none') && (
                  <ul>
                    {s.matched.map((m) => <li key={m}><Check size={12} />{m}</li>)}
                    {/* Names and addresses are public: say so when that is all there is. */}
                    {s.senderOnCase === 'none' && <li className="amber"><AlertTriangle size={12} />Not from anyone on this case: only what it says matches</li>}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="ef-acts">
          <button className={item.suggestions.length ? 'ef-alt' : 'ef-file'} disabled={busy} onClick={() => setPicking((p) => !p)}>{picking ? 'Cancel' : item.suggestions.length ? 'A different case…' : 'Choose a case…'}</button>
          <button className="ef-alt" disabled={busy} onClick={onNotACase}><X size={13} /> Not a case</button>
          {item.webLink && <a className="ef-alt" href={item.webLink} target="_blank" rel="noopener noreferrer"><Mail size={13} /> Outlook</a>}
        </div>
        {picking && (
          <div className="ef-pick">
            <input autoFocus placeholder="Address, client's name or reference" value={q} onChange={(e) => setQ(e.target.value)} />
            {hits.map((m) => (
              <button key={m.id} className="ef-hit" disabled={busy} onClick={() => onFile(m.id)}>
                <span style={{ minWidth: 0 }}><b>{m.propertyAddress}</b><span className="who">{describe(m.case)}</span></span>
                <span style={{ color: '#94a3b8', fontSize: 11.5, whiteSpace: 'nowrap' }}>{m.matterRef}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ef-msg">
        {readErr && <div className="eg-err" style={{ margin: 12 }}>{readErr}</div>}
        {!full && !readErr && <p className="ef-text" style={{ color: '#94a3b8' }}>{item.bodyPreview}</p>}
        {full && (
          <>
            <div className="ef-meta">
              {full.to.length > 0 && <span><b>To</b>{full.to.map(person).join(', ')}</span>}
              {full.cc.length > 0 && <span><b>Cc</b>{full.cc.map(person).join(', ')}</span>}
            </div>
            {full.attachments.length > 0 && <div className="ef-att">{full.attachments.map((a) => <span key={a.id}><Paperclip size={12} />{a.name}</span>)}</div>}
            {full.body.contentType === 'html'
              ? <iframe className="ef-body" title={full.subject || 'Email'} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={shell(full.body.content)} />
              : <pre className="ef-text">{full.body.content}</pre>}
          </>
        )}
      </div>
    </div>
  );
}
