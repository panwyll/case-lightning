'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { paths } from '@/lib/paths';
import { Paperclip, Check, X, Mail } from '@/app/shared/icons';

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
.ef-go{display:inline-flex;gap:8px;align-items:center;border:1px solid #5A27E0;background:#5A27E0;color:#fff;border-radius:10px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
.ef-go:hover{background:#4c1fc4}
.ef-go:disabled{opacity:.5;cursor:not-allowed}
.ef-pill{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;border-radius:99px;padding:2px 8px;background:rgba(255,255,255,.22)}
.ef-alt{border:1px solid #e2e8f0;background:#fff;border-radius:10px;padding:8px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;color:#334155;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.ef-alt:hover{background:#f8fafc}
.ef-alt:disabled{opacity:.5;cursor:not-allowed}
.ef-why{color:#94a3b8;font-size:12px;margin-top:8px}
.ef-pick{margin-top:10px;background:#f8fafc;border:1px solid #e6e8ee;border-radius:12px;padding:10px}
.ef-pick input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:13.5px;font-family:inherit;background:#fff}
.ef-hit{display:flex;justify-content:space-between;gap:10px;width:100%;text-align:left;border:1px solid transparent;background:#fff;border-radius:9px;padding:8px 12px;font-size:13px;cursor:pointer;font-family:inherit;margin-top:6px;color:#0f172a}
.ef-hit:hover{border-color:#c4b5fd;background:#f5f3ff}
.ef-hit b{color:#5A27E0}
.ef-done{text-align:center;padding:48px 16px;color:#64748b;background:#fff;border:1px solid #e6e8ee;border-radius:14px}
.ef-done b{display:block;font-size:19px;color:#0f172a;margin-bottom:6px}
`;

const BAND: Record<string, string> = { high: 'almost certain', medium: 'likely', low: 'possible' };
const HUES = ['#5A27E0', '#0ea5e9', '#16a34a', '#d97706', '#db2777', '#0f766e', '#7c3aed', '#b45309'];

interface Suggestion { matterId: string; matterRef: string; propertyAddress: string; band: string; why: string[] }
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
}
interface MatterHit { id: string; matterRef: string; propertyAddress: string }

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
  const rest = item.suggestions.slice(1, 3);
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
        <div className="ef-acts">
          {top ? (
            <button className="ef-go" disabled={busy} onClick={() => onFile(top.matterId)}>
              <Check size={14} /> File to {top.matterRef}<span className="ef-pill">{BAND[top.band] ?? top.band}</span>
            </button>
          ) : (
            <span className="eg-sub">No case looks like a match.</span>
          )}
          {rest.map((s) => <button key={s.matterId} className="ef-alt" disabled={busy} onClick={() => onFile(s.matterId)}>{s.matterRef}</button>)}
          <button className="ef-alt" disabled={busy} onClick={() => setPicking((p) => !p)}>{picking ? 'Cancel' : 'Another case…'}</button>
          <button className="ef-alt" disabled={busy} onClick={onNotACase}><X size={13} /> Not a case</button>
          {item.webLink && <a className="ef-alt" href={item.webLink} target="_blank" rel="noopener noreferrer"><Mail size={13} /> Outlook</a>}
        </div>
        {top && <div className="ef-why">{top.propertyAddress}{top.why.length ? ` · ${top.why.join(' · ')}` : ''}</div>}
        {picking && (
          <div className="ef-pick">
            <input autoFocus placeholder="Reference, address or a party's name" value={q} onChange={(e) => setQ(e.target.value)} />
            {hits.map((m) => (
              <button key={m.id} className="ef-hit" disabled={busy} onClick={() => onFile(m.id)}><b>{m.matterRef}</b><span style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.propertyAddress}</span></button>
            ))}
            {q.trim().length >= 2 && hits.length === 0 && <div className="eg-sub" style={{ marginTop: 8 }}>No case matches that.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
