'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { paths } from '@/lib/paths';

/**
 * Filing email to cases (docs/email-filing.md).
 *
 * This is not an inbox and must never grow into one. There is no read/unread, no
 * folders, no reply, no archive. There is one question per email — which case is this? —
 * and the row leaves the moment it is answered. The list is meant to reach zero.
 */
const CSS = `
.fq-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.fq-count{font-size:34px;font-weight:800;line-height:1;letter-spacing:-0.02em}
.fq-row{border:1px solid #e6e8ee;border-radius:12px;padding:12px 14px;background:#fff;margin-bottom:8px}
.fq-row.going{opacity:.45;transition:opacity .2s}
.fq-from{font-weight:700;font-size:13.5px}
.fq-subject{font-size:14.5px;font-weight:600;margin:2px 0 0}
.fq-prev{color:#64748b;font-size:12.5px;margin:4px 0 0;max-width:80ch;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.fq-acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.fq-suggest{display:flex;gap:6px;align-items:center;border:1px solid #c4b5fd;background:#f5f3ff;color:#4c1d95;border-radius:9px;padding:7px 11px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
.fq-suggest:hover{background:#ede9fe}
.fq-suggest:disabled{opacity:.5;cursor:not-allowed}
.fq-alt{border:1px solid #e2e8f0;background:#fff;border-radius:9px;padding:7px 10px;font-size:12.5px;cursor:pointer;font-family:inherit;color:#334155}
.fq-why{color:#64748b;font-size:11.5px;margin-top:6px}
.fq-band{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;border-radius:99px;padding:1px 7px}
.fq-pick{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.fq-pick input{flex:1;min-width:220px;padding:7px 10px;border:1px solid #cbd5e1;border-radius:9px;font-size:13px;font-family:inherit}
.fq-hit{display:block;width:100%;text-align:left;border:1px solid #e2e8f0;background:#fff;border-radius:9px;padding:7px 10px;font-size:12.5px;cursor:pointer;font-family:inherit;margin-top:4px}
.fq-hit:hover{background:#f8fafc}
.fq-done{text-align:center;padding:48px 16px;color:#64748b}
.fq-done b{display:block;font-size:19px;color:#0f172a;margin-bottom:6px}
`;

const BAND: Record<string, { bg: string; fg: string; label: string }> = {
  high: { bg: '#dcfce7', fg: '#14532d', label: 'almost certain' },
  medium: { bg: '#fef3c7', fg: '#78350f', label: 'likely' },
  low: { bg: '#f1f5f9', fg: '#475569', label: 'possible' },
};

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

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function EmailFilingPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** The mailbox itself is not connected — a different problem, with a different answer. */
  const [noMailbox, setNoMailbox] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [going, setGoing] = useState<Set<string>>(new Set());
  const [filedCount, setFiledCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Item[] }>('/mail/unfiled?top=25');
      setItems(r.items);
      setErr(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not read your mailbox.';
      // "Graph account not connected" is not an error to show a conveyancer — it is a
      // missing step, and it has a button.
      if (/graph account not connected/i.test(msg)) {
        setNoMailbox(true);
        setItems([]);
      } else {
        setErr(msg);
      }
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /** Optimistic: the row goes as soon as the answer is given. */
  const retire = (id: string) => {
    setGoing((g) => new Set(g).add(id));
    setTimeout(() => setItems((cur) => (cur ?? []).filter((i) => i.id !== id)), 180);
  };

  const fileTo = async (item: Item, matterId: string) => {
    setBusy(item.id);
    setErr(null);
    try {
      await api(`/matters/${matterId}/link-thread`, {
        method: 'POST',
        body: JSON.stringify({
          graphThreadId: item.conversationId ?? item.id,
          graphConversationId: item.conversationId ?? undefined,
          messageId: item.id,
          subject: item.subject,
          participants: [item.from.address].filter(Boolean),
        }),
      });
      setFiledCount((n) => n + 1);
      retire(item.id);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not file that email.');
    } finally {
      setBusy(null);
    }
  };

  const notACase = async (item: Item) => {
    setBusy(item.id);
    try {
      await api('/mail/not-a-case', { method: 'POST', body: JSON.stringify({ conversationId: item.conversationId ?? item.id, subject: item.subject }) });
      retire(item.id);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not set that aside.');
    } finally {
      setBusy(null);
    }
  };

  const left = (items ?? []).filter((i) => !going.has(i.id)).length;

  return (
    <div className="eg" style={{ maxWidth: 900, margin: '0 auto', padding: '16px 16px 48px' }}>
      <style>{ENGINE_CSS + CSS}</style>
      <div className="fq-head">
        <div>
          <h1 className="eg-h1">Email</h1>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="fq-count">{items === null ? '—' : left}</div>
          <div className="eg-sub">to file</div>
        </div>
      </div>

      {err && <div className="eg-err">{err}</div>}
      {items === null && !err && !noMailbox && <div className="eg-sub">Loading…</div>}

      {noMailbox && (
        <div className="fq-done">
          <b>Mailbox not connected.</b>
          <div style={{ marginTop: 14 }}>
            <a className="eg-btn primary" href="/api/v1/auth/login?flow=web&consent=1">Connect Microsoft 365</a>{' '}
            <a className="eg-btn" href={paths.support}>What this can see</a>
          </div>
        </div>
      )}

      {!noMailbox && items !== null && left === 0 && (
        <div className="fq-done">
          <b>Nothing to file.</b>
          <div style={{ marginTop: 14 }}>
            <a className="eg-btn" href={paths.tasks}>Tasks</a>{' '}
            <a className="eg-btn" href={paths.cases}>Caseload</a>
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
  const rest = item.suggestions.slice(1);

  useEffect(() => {
    if (!picking || q.trim().length < 2) return;
    const t = setTimeout(async () => {
      try {
        const r = await api<{ matters: MatterHit[] }>(`/matters?q=${encodeURIComponent(q.trim())}`);
        setHits((r.matters ?? []).slice(0, 6));
      } catch {
        setHits([]);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [picking, q]);

  return (
    <div className={`fq-row${going ? ' going' : ''}`}>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="fq-from">{item.from.name ?? item.from.address ?? 'Unknown sender'}</span>
        <span className="eg-sub">{when(item.receivedDateTime)}{item.hasAttachments ? ' · attachment' : ''}</span>
      </div>
      <p className="fq-subject">{item.subject}</p>
      <p className="fq-prev">{item.bodyPreview}</p>

      <div className="fq-acts">
        {top ? (
          <button className="fq-suggest" disabled={busy} onClick={() => onFile(top.matterId)}>
            File to {top.matterRef}
            <span className="fq-band" style={{ background: BAND[top.band]?.bg ?? '#f1f5f9', color: BAND[top.band]?.fg ?? '#475569' }}>{BAND[top.band]?.label ?? top.band}</span>
          </button>
        ) : (
          <span className="eg-sub">No case looks like a match.</span>
        )}
        {rest.map((s) => (
          <button key={s.matterId} className="fq-alt" disabled={busy} onClick={() => onFile(s.matterId)}>or {s.matterRef}</button>
        ))}
        <button className="fq-alt" disabled={busy} onClick={() => setPicking((p) => !p)}>{picking ? 'Cancel' : 'Another case…'}</button>
        <button className="fq-alt" disabled={busy} onClick={onNotACase}>Not case email</button>
        {item.webLink && <a className="fq-alt" href={item.webLink} target="_blank" rel="noopener noreferrer">Open in Outlook ↗</a>}
      </div>

      {top && <div className="fq-why">{top.propertyAddress}{top.why.length ? ` — ${top.why.join('; ')}` : ''}</div>}

      {picking && (
        <div className="fq-pick">
          <input autoFocus placeholder="Search by reference, address or party…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div style={{ width: '100%' }}>
            {hits.map((m) => (
              <button key={m.id} className="fq-hit" disabled={busy} onClick={() => onFile(m.id)}>
                <b>{m.matterRef}</b> — {m.propertyAddress}
              </button>
            ))}
            {q.trim().length >= 2 && hits.length === 0 && <div className="eg-sub" style={{ marginTop: 6 }}>No case matches that.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
