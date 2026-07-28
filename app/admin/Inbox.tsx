'use client';
import { useCallback, useEffect, useState } from 'react';
import { useAssist } from '@/app/shared/assist/useAssist';

/**
 * The web inbox — zero-install CONVEYi. Lists the signed-in user's mail and runs the
 * same triage/match/draft loop the Outlook add-in does, via the shared useAssist hook.
 *
 * Two rules this surface must respect:
 *  - Rows render READ-ONLY from the precomputed cache (GET /mail never runs assist),
 *    so scrolling can't burn the firm's monthly AI quota. Analysis happens on open.
 *  - Read + drafts only: we never mark read, move or re-file mail, so we don't fight
 *    the real Outlook client for mailbox state.
 */

type Api = <T = any>(path: string, options?: RequestInit) => Promise<T>;

interface MailRow {
  id: string;
  subject: string;
  from: { name: string | null; address: string | null };
  receivedDateTime: string | null;
  bodyPreview: string;
  conversationId: string | null;
  hasAttachments: boolean;
  isRead: boolean;
  webLink: string | null;
  assist: null | {
    status: string;
    matchBand: string | null;
    matter: { id: string; matterRef: string; propertyAddress: string | null } | null;
    intent: string | null;
    urgency: string | null;
    needsAttention: boolean;
    ask: string | null;
  };
}

const PURPLE = '#5A27E0';
const INTENT_LABEL: Record<string, string> = {
  ACTION_REQUIRED: 'Action', ENQUIRY: 'Enquiry', CHASE: 'Chase', DOCUMENT_DELIVERY: 'Documents',
  UPDATE: 'Update', CONFIRMATION: 'Confirmation', NO_ACTION: 'FYI', SPAM: 'Spam',
};
const when = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso); const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

export default function Inbox({ api }: { api: Api }) {
  const [rows, setRows] = useState<MailRow[]>([]);
  const [nextLink, setNextLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<MailRow | null>(null);

  // Surface-local busy/status, wired into the shared hook exactly as the taskpane does.
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [quota, setQuota] = useState<{ used: number; cap: number; hoursSaved: number } | null>(null);
  const [matterId, setMatterId] = useState('');
  const [replyReady, setReplyReady] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(label); setStatus(null);
    try { return await fn(); }
    catch (e: any) { setStatus(e?.message || 'Something went wrong.'); return null; }
    finally { setBusy(''); }
  }, []);

  const { assist, assistError, runAssist } = useAssist({
    messageId: sel?.id ?? '',
    conversationId: sel?.conversationId ?? '',
    api,
    run,
    onQuota: setQuota,
    onMatterFound: setMatterId,
  });

  const load = useCallback(async (cursor?: string | null) => {
    cursor ? setMore(true) : setLoading(true);
    try {
      const r = await api<{ items: MailRow[]; nextLink: string | null }>(`/mail${cursor ? `?nextLink=${encodeURIComponent(cursor)}` : ''}`);
      setRows((prev) => (cursor ? [...prev, ...(r.items ?? [])] : r.items ?? []));
      setNextLink(r.nextLink ?? null);
      setErr(null);
    } catch (e: any) { setErr(e?.message || 'Could not load your mail.'); }
    finally { setLoading(false); setMore(false); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  // Opening a message is the deliberate action that may cost an assist call.
  const open = (m: MailRow) => {
    setSel(m);
    setMatterId(m.assist?.matter?.id ?? '');
    setReplyReady(false); setDraftId(null); setSent(false); setStatus(null);
  };
  useEffect(() => { if (sel?.id && sel.conversationId) void runAssist(sel.assist?.matter?.id ?? undefined); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sel?.id]);

  const draftReply = async (regen = false) => {
    if (!sel?.conversationId) return;
    const cid = encodeURIComponent(sel.conversationId);
    const ok = await run(regen ? 'Updating the reply' : 'Writing the reply', async () => {
      let subject = regen ? undefined : assist?.draft?.subject;
      let bodyHtml = regen ? undefined : assist?.draft?.bodyHtml;
      if (!bodyHtml) {
        const g = await api<{ subject: string; bodyHtml: string }>(`/threads/${cid}/draft-reply`, {
          method: 'POST',
          body: JSON.stringify({ matterId: matterId || undefined, messageId: sel.id, conversationId: sel.conversationId, tone: 'NEUTRAL' }),
        });
        subject = g.subject; bodyHtml = g.bodyHtml;
      }
      const r = await api<{ draftId: string }>(`/threads/${cid}/create-draft`, {
        method: 'POST',
        body: JSON.stringify({ matterId: matterId || undefined, messageId: sel.id, subject, bodyHtml }),
      });
      setDraftId(r.draftId ?? null); setReplyReady(true);
      return true;
    });
    if (ok) setStatus(regen ? 'Reply updated in Outlook drafts.' : 'Reply drafted in Outlook.');
  };

  const sendReply = async () => {
    if (!draftId) return;
    const ok = await run('Sending the reply', async () => {
      await api('/worklist/send', { method: 'POST', body: JSON.stringify({ messageId: draftId, source: 'WEB' }) });
      return true;
    });
    if (ok) { setSent(true); setReplyReady(false); setStatus('Reply sent.'); }
  };

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', height: 'calc(100vh - 170px)', minHeight: 480 }}>
      {/* ── List ───────────────────────────────────────────────────────────── */}
      <div style={{ ...card, width: 380, flex: 'none', padding: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #eef2f7', display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 14, flex: 1 }}>Inbox</strong>
          <button onClick={() => load()} style={btn} disabled={loading}>{loading ? '…' : 'Refresh'}</button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {err && <div style={{ padding: 12, color: '#b91c1c', fontSize: 12.5 }}>{err}</div>}
          {loading && !rows.length && <div style={{ padding: 12, color: '#94a3b8', fontSize: 12.5 }}>Loading your mail…</div>}
          {!loading && !rows.length && !err && <div style={{ padding: 12, color: '#94a3b8', fontSize: 12.5 }}>Nothing in your inbox.</div>}
          {rows.map((m) => {
            const on = sel?.id === m.id;
            const a = m.assist;
            return (
              <button key={m.id} onClick={() => open(m)} style={{
                display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                background: on ? '#F2EEFC' : 'transparent', borderBottom: '1px solid #f1f5f9', padding: '9px 12px',
              }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <span style={{ fontSize: 12.5, fontWeight: m.isRead ? 600 : 800, color: '#0f172a', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.from.name || m.from.address || 'Unknown'}
                  </span>
                  <span style={{ fontSize: 10.5, color: '#94a3b8', flex: 'none' }}>{when(m.receivedDateTime)}</span>
                </div>
                <div style={{ fontSize: 12, color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                  {m.hasAttachments ? '📎 ' : ''}{m.subject}
                </div>
                <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                  {a?.matter && <span style={chip('#EDE7FB', PURPLE)}>{a.matter.matterRef}</span>}
                  {a?.intent && <span style={chip('#f1f5f9', '#475569')}>{INTENT_LABEL[a.intent] ?? a.intent}</span>}
                  {a?.needsAttention && <span style={chip('#fef3c7', '#b45309')}>Needs you</span>}
                  {!a && <span style={{ ...chip('#f8fafc', '#94a3b8'), border: '1px dashed #e2e8f0' }}>Not analysed</span>}
                </div>
              </button>
            );
          })}
          {nextLink && (
            <div style={{ padding: 10, textAlign: 'center' }}>
              <button onClick={() => load(nextLink)} style={btn} disabled={more}>{more ? 'Loading…' : 'Load more'}</button>
            </div>
          )}
        </div>
      </div>

      {/* ── Detail ─────────────────────────────────────────────────────────── */}
      <div style={{ ...card, flex: 1, minWidth: 0, height: '100%', overflowY: 'auto' }}>
        {!sel ? (
          <div style={{ color: '#94a3b8', fontSize: 13 }}>Pick an email to see the situation, the matter it belongs to and a prepared reply.</div>
        ) : (
          <>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{sel.subject}</div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              {sel.from.name || ''} {sel.from.address ? `<${sel.from.address}>` : ''} · {when(sel.receivedDateTime)}
              {sel.webLink && <> · <a href={sel.webLink} target="_blank" rel="noopener noreferrer" style={{ color: PURPLE }}>Open in Outlook</a></>}
            </div>

            {busy && <div style={note('#EDE7FB', PURPLE)}>{busy}…</div>}
            {status && <div style={note('#ecfdf5', '#065f46')}>{status}</div>}
            {quota && <div style={note('#fffbeb', '#92400e')}>Monthly email cap reached ({quota.used}/{quota.cap}). New emails aren’t analysed until it resets.</div>}
            {assistError && !busy && (
              <div style={note('#fef2f2', '#b91c1c')}>
                Couldn’t read this email. <button onClick={() => runAssist(matterId || undefined)} style={{ ...btn, marginLeft: 6, padding: '2px 8px' }}>Retry</button>
              </div>
            )}

            {assist && (
              <>
                <div style={{ ...panel, marginTop: 10 }}>
                  <div style={lbl}>The situation</div>
                  <div style={{ fontSize: 13, color: '#1e293b', lineHeight: 1.5 }}>{assist.brief || assist.ask}</div>
                  {assist.matter ? (
                    <div style={{ marginTop: 8, fontSize: 12, color: '#334155' }}>
                      <span style={chip('#EDE7FB', PURPLE)}>{assist.matter.matterRef}</span>{' '}
                      {assist.matter.propertyAddress || ''}
                    </div>
                  ) : (
                    <div style={{ marginTop: 8, fontSize: 11.5, color: '#94a3b8' }}>No matter matched yet.</div>
                  )}
                </div>

                {assist.whatWeKnow?.length > 0 && (
                  <div style={panel}>
                    <div style={lbl}>What we know</div>
                    <ul style={ul}>{assist.whatWeKnow.map((x, i) => <li key={i} style={li}>{x}</li>)}</ul>
                  </div>
                )}
                {assist.outstanding?.length > 0 && (
                  <div style={panel}>
                    <div style={lbl}>Outstanding</div>
                    <ul style={ul}>{assist.outstanding.map((x, i) => <li key={i} style={li}>{x}</li>)}</ul>
                  </div>
                )}
                {(assist.documents?.length ?? 0) > 0 && (
                  <div style={panel}>
                    <div style={lbl}>Attached documents</div>
                    {assist.documents!.map((d, i) => (
                      <div key={i} style={{ fontSize: 12, color: '#334155', marginBottom: 5 }}>
                        <strong>{d.name}</strong> <span style={{ color: '#94a3b8' }}>· {d.docType}</span>
                        <div style={{ color: '#475569', marginTop: 1 }}>{d.summary}</div>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ ...panel, borderColor: replyReady ? '#a7f3d0' : '#e8eaf0', background: replyReady ? '#f0fdf4' : '#fbfbfe' }}>
                  <div style={lbl}>Reply</div>
                  {!assist.ready && <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 6 }}>Preparing a reply…</div>}
                  {sent ? (
                    <div style={{ fontSize: 12.5, color: '#065f46', fontWeight: 600 }}>✓ Sent</div>
                  ) : (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      {!replyReady && <button onClick={() => draftReply(false)} disabled={!!busy} style={primary}>Draft a reply</button>}
                      {replyReady && (
                        <>
                          <span style={{ fontSize: 12.5, color: '#065f46', fontWeight: 600, marginRight: 4 }}>✓ Drafted in Outlook</span>
                          <button onClick={() => draftReply(true)} disabled={!!busy} style={btn}>Regenerate</button>
                          <button onClick={sendReply} disabled={!!busy} style={primary}>Send</button>
                        </>
                      )}
                    </div>
                  )}
                  {assist.draft?.why?.length ? (
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 7 }}>Why: {assist.draft.why.join(' · ')}</div>
                  ) : null}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: 12 };
const panel: React.CSSProperties = { background: '#fbfbfe', border: '1px solid #e8eaf0', borderRadius: 10, padding: 10, marginTop: 8 };
const btn: React.CSSProperties = { fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#334155', cursor: 'pointer' };
const primary: React.CSSProperties = { ...btn, background: PURPLE, color: '#fff', border: 'none', fontWeight: 700 };
const lbl: React.CSSProperties = { fontSize: 10, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 5 };
const ul: React.CSSProperties = { margin: 0, paddingLeft: 16 };
const li: React.CSSProperties = { fontSize: 12.5, color: '#334155', lineHeight: 1.5, marginBottom: 2 };
const chip = (bg: string, fg: string): React.CSSProperties => ({ fontSize: 10, fontWeight: 800, background: bg, color: fg, borderRadius: 99, padding: '1px 7px', whiteSpace: 'nowrap' });
const note = (bg: string, fg: string): React.CSSProperties => ({ background: bg, color: fg, borderRadius: 8, padding: '7px 10px', fontSize: 12.5, fontWeight: 600, marginTop: 8 });
