'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { paths } from '@/lib/paths';
import { Paperclip, Check, X, Mail, ChevronDown, AlertTriangle, Home } from '@/app/shared/icons';

/**
 * Filing email to cases (docs/email-filing.md).
 *
 * Not an inbox. No read/unread, no folders, no reply. One question per email — which
 * case is this? — and the row leaves the moment it is answered. The list is meant to
 * reach zero.
 */
const CSS = `
.ef-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.ef-count{font-size:34px;font-weight:800;line-height:1;letter-spacing:-0.02em}
.ef-row{display:grid;grid-template-columns:40px 1fr;gap:12px;border:1px solid #e6e8ee;border-radius:14px;padding:14px 16px;background:#fff;margin-bottom:8px;box-shadow:0 1px 2px rgba(16,24,40,.04);transition:opacity .2s,transform .2s}
.ef-row.going{opacity:0;transform:translateX(20px)}
.ef-av{width:40px;height:40px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#fff}
.ef-top{display:flex;gap:10px;justify-content:space-between;align-items:baseline;flex-wrap:wrap}
.ef-from{font-weight:700;font-size:13.5px;color:#0f172a}
.ef-addr{font-weight:400;color:#94a3b8;font-size:12px;margin-left:6px}
.ef-when{color:#94a3b8;font-size:12px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.ef-subj{font-size:15px;font-weight:700;margin:3px 0 0;color:#0f172a}
.ef-prev{color:#64748b;font-size:13px;margin:4px 0 0;max-width:80ch;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.45}
.ef-acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
.ef-alt{border:1px solid #e2e8f0;background:#fff;border-radius:10px;padding:8px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;color:#334155;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.ef-alt:hover{background:#f8fafc}
.ef-alt:disabled{opacity:.5;cursor:not-allowed}
.ef-pick{margin-top:10px;background:#f8fafc;border:1px solid #e6e8ee;border-radius:12px;padding:10px}
.ef-pick input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:13.5px;font-family:inherit;background:#fff}
.ef-hit{display:flex;justify-content:space-between;gap:10px;width:100%;text-align:left;border:1px solid transparent;background:#fff;border-radius:9px;padding:8px 12px;font-size:13px;cursor:pointer;font-family:inherit;margin-top:6px;color:#0f172a}
.ef-hit:hover{border-color:#c4b5fd;background:#f5f3ff}
.ef-hit b{color:#5A27E0}
.ef-pct{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:800;border-radius:99px;padding:2px 8px;font-variant-numeric:tabular-nums;white-space:nowrap}
.ef-pct i{width:7px;height:7px;border-radius:99px;display:inline-block}
.ef-open{margin-top:12px;border:1px solid #e6e8ee;border-radius:12px;background:#fafafa;overflow:hidden}
.ef-meta{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;padding:10px 14px;font-size:12.5px;border-bottom:1px solid #eef1f5;background:#fff}
.ef-meta dt{color:#94a3b8;font-weight:600}
.ef-meta dd{margin:0;color:#334155;overflow-wrap:anywhere}
.ef-att{display:flex;gap:6px;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid #eef1f5;background:#fff}
.ef-att span{display:inline-flex;align-items:center;gap:5px;font-size:12px;border:1px solid #e2e8f0;border-radius:8px;padding:3px 8px;color:#334155}
.ef-body{width:100%;height:420px;border:0;background:#fff;display:block}
.ef-text{white-space:pre-wrap;font-size:13px;line-height:1.5;color:#334155;padding:12px 14px;max-height:420px;overflow:auto;margin:0;font-family:inherit}
.ef-cases{display:grid;gap:8px;margin-top:12px}
.ef-case{display:grid;grid-template-columns:auto 1fr auto;gap:4px 12px;align-items:center;border:1px solid #e6e8ee;border-radius:12px;padding:10px 12px;background:#fff}
.ef-case.top{border-color:#c4b5fd;background:#faf8ff}
.ef-case .ic{color:#7c3aed;display:flex;grid-row:span 2;align-self:start;margin-top:2px}
.ef-case .addr{font-size:14px;font-weight:800;color:#0f172a;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ef-case .ref{font-size:11px;font-weight:600;color:#94a3b8}
.ef-case .who{font-size:12.5px;color:#475569;grid-column:2}
.ef-case .side{grid-row:1 / span 2;grid-column:3;display:flex;gap:8px;align-items:center}
.ef-case ul{grid-column:2 / -1;list-style:none;margin:4px 0 0;padding:0;display:flex;gap:4px 14px;flex-wrap:wrap}
.ef-case li{display:inline-flex;gap:5px;align-items:center;font-size:12px;color:#166534}
.ef-case li svg{flex:0 0 auto}
.ef-file{display:inline-flex;gap:6px;align-items:center;border:1px solid #5A27E0;background:#5A27E0;color:#fff;border-radius:9px;padding:7px 12px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}
.ef-file.ghost{background:#fff;color:#5A27E0}
.ef-file:disabled{opacity:.5;cursor:not-allowed}
.ef-warn{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin-top:10px;border:1px solid #fecaca;background:#fef2f2;color:#991b1b;border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.45}
.ef-warn b{font-size:13px}
.ef-warn svg{margin-top:1px}
.ef-hit .who{display:block;font-size:12px;color:#64748b;margin-top:2px}
@media (max-width:760px){.ef-case{grid-template-columns:auto 1fr}.ef-case .side{grid-row:auto;grid-column:2}}
.ef-done{text-align:center;padding:48px 16px;color:#64748b;background:#fff;border:1px solid #e6e8ee;border-radius:14px}
.ef-done b{display:block;font-size:19px;color:#0f172a;margin-bottom:6px}
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
function Pct({ s }: { s: Suggestion }) {
  const c = RAG[s.band] ?? RAG.WEAK;
  return <span className="ef-pct" style={{ color: c.fg, background: c.bg }}><i style={{ background: c.dot }} />{Math.round(s.score * 100)}%</span>;
}
const HUES = ['#5A27E0', '#0ea5e9', '#16a34a', '#d97706', '#db2777', '#0f766e', '#7c3aed', '#b45309'];

interface CaseCard { matterId: string; matterRef: string; propertyAddress: string | null; type: string; clients: string[]; stage: string | null; handler: string | null; otherSide: string | null; closed: boolean }
interface Suggestion { matterId: string; matterRef: string; propertyAddress: string; band: string; score: number; case: CaseCard | null; matched: string[] }
interface Person { name: string | null; address: string | null }
interface FullMessage { subject: string; from: Person | null; to: Person[]; cc: Person[]; receivedDateTime: string | null; body: { contentType: 'html' | 'text'; content: string }; attachments: Array<{ id: string; name: string; size: number }> }
const person = (p: Person) => (p.name && p.address ? `${p.name} <${p.address}>` : p.name || p.address || '');
/** The email in a sandbox: no scripts, no remote content (tracking pixels stay unloaded). */
const shell = (html: string) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><base target="_blank"><style>body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1e293b;margin:12px 14px;overflow-wrap:anywhere}img{max-width:100%;height:auto}img:not([src^="data:"]){display:none}</style></head><body>${html}</body></html>`;
interface Item {
  id: string;
  conversationId: string | null;
  subject: string;
  from: { name: string | null; address: string | null };
  receivedDateTime: string | null;
  bodyPreview: string;
  hasAttachments: boolean;
  webLink: string | null;
  suggestions: Suggestion[];
  sender?: { verdict: 'ok' | 'unverified' | 'suspicious'; warnings: string[] };
}
interface MatterHit { id: string; matterRef: string; propertyAddress: string; case: CaseCard | null }

/** "Purchase for Priya Shah · Searches & enquiries · Alice Okafor" */
const describe = (c: CaseCard | null) =>
  c ? [`${c.type}${c.clients.length ? ` for ${c.clients.join(' & ')}` : ''}`, c.closed ? 'Closed' : c.stage, c.handler].filter(Boolean).join(' · ') : '';

/** One case, the way a person recognises it, with what in the email points to it. */
function CaseOption({ s, top, busy, onFile }: { s: Suggestion; top: boolean; busy: boolean; onFile: () => void }) {
  return (
    <div className={`ef-case${top ? ' top' : ''}`}>
      <span className="ic"><Home size={16} /></span>
      <span className="addr">{s.case?.propertyAddress ?? s.propertyAddress}<span className="ref">{s.matterRef}</span></span>
      <span className="side"><Pct s={s} /><button className={`ef-file${top ? '' : ' ghost'}`} disabled={busy} onClick={onFile}><Check size={13} /> File here</button></span>
      <span className="who">{describe(s.case)}{s.case?.otherSide ? ` · other side ${s.case.otherSide}` : ''}</span>
      {s.matched.length > 0 && <ul>{s.matched.map((m) => <li key={m}><Check size={12} />{m}</li>)}</ul>}
    </div>
  );
}

const when = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso); const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};
const initials = (name: string | null, address: string | null) => {
  const src = (name || address || '?').replace(/@.*/, '').replace(/[._-]+/g, ' ').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
};
const hue = (s: string) => HUES[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];

export default function EmailToFile() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [noMailbox, setNoMailbox] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [going, setGoing] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Item[] }>('/mail/unfiled?top=25');
      setItems(r.items);
      setErr(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not read your mailbox.';
      if (/graph account not connected/i.test(msg)) { setNoMailbox(true); setItems([]); } else setErr(msg);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const retire = (id: string) => {
    setGoing((g) => new Set(g).add(id));
    setTimeout(() => setItems((cur) => (cur ?? []).filter((i) => i.id !== id)), 200);
  };
  const fileTo = async (item: Item, matterId: string) => {
    setBusy(item.id); setErr(null);
    try {
      await api(`/matters/${matterId}/link-thread`, { method: 'POST', body: JSON.stringify({ graphThreadId: item.conversationId ?? item.id, graphConversationId: item.conversationId ?? undefined, messageId: item.id, subject: item.subject, participants: [item.from.address].filter(Boolean) }) });
      retire(item.id);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not file that email.');
    } finally { setBusy(null); }
  };
  const notACase = async (item: Item) => {
    setBusy(item.id); setErr(null);
    try {
      await api('/mail/not-a-case', { method: 'POST', body: JSON.stringify({ conversationId: item.conversationId ?? item.id, subject: item.subject }) });
      retire(item.id);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not set that aside.');
    } finally { setBusy(null); }
  };

  const left = (items ?? []).filter((i) => !going.has(i.id)).length;

  return (
    <div>
      <style>{CSS}</style>
      <div className="ef-head">
        <h1 className="eg-h1">Email</h1>
        <div style={{ textAlign: 'right' }}><div className="ef-count">{items === null ? '—' : left}</div><div className="eg-sub">to file</div></div>
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
      {(items ?? []).map((item) => (
        <Row key={item.id} item={item} going={going.has(item.id)} busy={busy === item.id} onFile={(m) => fileTo(item, m)} onNotACase={() => notACase(item)} />
      ))}
    </div>
  );
}

function Row({ item, going, busy, onFile, onNotACase }: { item: Item; going: boolean; busy: boolean; onFile: (matterId: string) => void; onNotACase: () => void }) {
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<MatterHit[]>([]);
  const top = item.suggestions[0];
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<FullMessage | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const toggleOpen = async () => {
    const next = !open;
    setOpen(next);
    if (next && !full) {
      try { setFull((await api<{ message: FullMessage }>(`/mail/message/${encodeURIComponent(item.id)}`)).message); setReadErr(null); }
      catch (e: unknown) { setReadErr(e instanceof Error ? e.message : 'Could not open the email.'); }
    }
  };
  const who = item.from.name ?? item.from.address ?? 'Unknown sender';

  useEffect(() => {
    if (!picking || q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      try { setHits(((await api<{ matters: MatterHit[] }>(`/matters?q=${encodeURIComponent(q.trim())}`)).matters ?? []).slice(0, 6)); } catch { setHits([]); }
    }, 220);
    return () => clearTimeout(t);
  }, [picking, q]);

  return (
    <div className={`ef-row${going ? ' going' : ''}`}>
      <div className="ef-av" style={{ background: hue(item.from.address ?? who) }} aria-hidden>{initials(item.from.name, item.from.address)}</div>
      <div style={{ minWidth: 0 }}>
        <div className="ef-top">
          <span className="ef-from">{who}{item.from.name && item.from.address && <span className="ef-addr">{item.from.address}</span>}</span>
          <span className="ef-when">{item.hasAttachments && <Paperclip size={12} />}{when(item.receivedDateTime)}</span>
        </div>
        <p className="ef-subj">{item.subject || '(no subject)'}</p>
        {item.bodyPreview && <p className="ef-prev">{item.bodyPreview}</p>}
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
            {item.suggestions.map((sg, i) => <CaseOption key={sg.matterId} s={sg} top={i === 0} busy={busy} onFile={() => onFile(sg.matterId)} />)}
          </div>
        )}
        <div className="ef-acts">
          <button className="ef-alt" disabled={busy} onClick={() => setPicking((p) => !p)}>{picking ? 'Cancel' : top ? 'A different case…' : 'Choose a case…'}</button>
          <button className="ef-alt" disabled={busy} onClick={onNotACase}><X size={13} /> Not a case</button>
          <button className="ef-alt" onClick={toggleOpen} aria-expanded={open}><span style={{ display: 'inline-flex', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .12s' }}><ChevronDown size={13} /></span>{open ? 'Close' : 'Open'}</button>
          {item.webLink && <a className="ef-alt" href={item.webLink} target="_blank" rel="noopener noreferrer"><Mail size={13} /> Outlook</a>}
        </div>
        {open && (
          <div className="ef-open">
            {readErr && <div className="eg-err" style={{ margin: 10 }}>{readErr}</div>}
            {!full && !readErr && <div className="eg-sub" style={{ padding: 12 }}>Opening…</div>}
            {full && (
              <>
                <dl className="ef-meta">
                  {full.from && <><dt>From</dt><dd>{person(full.from)}</dd></>}
                  {full.to.length > 0 && <><dt>To</dt><dd>{full.to.map(person).join(', ')}</dd></>}
                  {full.cc.length > 0 && <><dt>Cc</dt><dd>{full.cc.map(person).join(', ')}</dd></>}
                  {full.receivedDateTime && <><dt>Received</dt><dd>{new Date(full.receivedDateTime).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</dd></>}
                </dl>
                {full.attachments.length > 0 && (
                  <div className="ef-att">{full.attachments.map((a) => <span key={a.id}><Paperclip size={12} />{a.name}</span>)}</div>
                )}
                {full.body.contentType === 'html'
                  ? <iframe className="ef-body" title={full.subject || 'Email'} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={shell(full.body.content)} />
                  : <pre className="ef-text">{full.body.content}</pre>}
              </>
            )}
          </div>
        )}
        {picking && (
          <div className="ef-pick">
            <input autoFocus placeholder="Address, client's name or reference" value={q} onChange={(e) => setQ(e.target.value)} />
            {hits.map((m) => (
              <button key={m.id} className="ef-hit" disabled={busy} onClick={() => onFile(m.id)}>
                <span style={{ minWidth: 0 }}><b style={{ color: '#0f172a' }}>{m.propertyAddress}</b><span className="who">{describe(m.case)}</span></span>
                <span style={{ color: '#94a3b8', fontSize: 11.5, whiteSpace: 'nowrap' }}>{m.matterRef}</span>
              </button>
            ))}
            {q.trim().length >= 2 && hits.length === 0 && <div className="eg-sub" style={{ marginTop: 8 }}>No case matches that.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
