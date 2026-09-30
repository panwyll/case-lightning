'use client';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Spin } from './BusyButton';
import { api } from './api';
import { ArrowLeft, Paperclip } from '@/app/shared/icons';

/** The shape GET /matters/:id/emails/thread returns (lib/server/email-thread.ts). */
export interface ThreadAddr { name: string | null; address: string | null }
export interface ThreadMsg {
  id: string;
  documentId: string | null;
  from: ThreadAddr;
  to: ThreadAddr[];
  cc: ThreadAddr[];
  date: string | null;
  subject: string;
  body: string;
  attachments: Array<{ name: string; documentId: string | null }>;
  mine: boolean;
  quoted: boolean;
}
export interface ThreadView { subject: string; messages: ThreadMsg[] }

/** An email file on a case: shown as its conversation, not as a text file. */
export const isEmailDoc = (d: { docType?: string | null; fileName?: string | null } | null | undefined): boolean =>
  !!d && (d.docType === 'EMAIL' || /^email-.*\.txt$/i.test(d.fileName ?? ''));

/** Which document the source pane should show as a conversation: the one on show, when it is an email and no quoted line is being pointed at. */
export function emailShownId(
  source: { id: string; docType?: string | null; fileName?: string | null } | null,
  showing: string | null,
  other: { id: string; content: string | null } | null,
  quote: string | null
): string | null {
  if (!showing || quote) return null;
  if (other) return other.content != null && /^From: [^\n]*\nTo: [^\n]*\nDate: [^\n]*\nSubject: /.test(other.content) ? other.id : null;
  return source && source.id === showing && isEmailDoc(source) ? source.id : null;
}

const CSS = `
.et{height:100%;min-height:0;display:flex;flex-direction:column;background:#f4f5f8;font-size:13.5px;color:#0f172a}
.et-subj{flex:none;padding:10px 16px;font-weight:800;font-size:14px;background:#fff;border-bottom:1px solid #e6e8ee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.et-scroll{flex:1;min-height:0;overflow:auto;padding:8px 14px 18px;display:flex;flex-direction:column;gap:8px}
.et-day{align-self:center;margin:10px 0 4px;padding:3px 10px;border-radius:999px;background:#e6e8ee;color:#475467;font-size:11.5px;font-weight:700}
.et-row{align-self:flex-start;display:flex;flex-direction:column;align-items:flex-start;max-width:min(86%,520px)}
.et-row.mine{align-self:flex-end;align-items:flex-end}
.et-b{all:unset;box-sizing:border-box;display:block;max-width:100%;cursor:pointer;background:#fff;border:1px solid #e2e5eb;border-radius:14px 14px 14px 4px;padding:8px 12px 9px;box-shadow:0 1px 1px rgba(15,23,42,.04);text-align:left}
.et-row.mine .et-b{background:#F2EEFC;border-color:#D9CCFA;border-radius:14px 14px 4px 14px}
.et-b:hover{border-color:#b8a4f5}
.et-b:focus-visible{outline:2px solid #5A27E0;outline-offset:2px}
.et-b.quoted{background:#fafafb;border-style:dashed;color:#475467}
.et-row.mine .et-b.quoted{background:#f8f6fd}
.et-b.at{box-shadow:0 0 0 3px rgba(90,39,224,.18);border-color:#5A27E0}
.et-who{display:flex;gap:8px;align-items:baseline;font-size:12px;margin-bottom:3px;min-width:0}
.et-who b{font-weight:700;color:#5A27E0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.et-row:not(.mine) .et-who b{color:#0f766e}
.et-b.quoted .et-who b{color:#64748b}
.et-who time{color:#94a3b8;font-size:11.5px;margin-left:auto;flex:none}
.et-txt{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45;display:-webkit-box;-webkit-line-clamp:14;-webkit-box-orient:vertical;overflow:hidden}
.et-atts{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px}
.et-row.mine .et-atts{justify-content:flex-end}
.et-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:4px 10px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#344054;font-size:12px;font-weight:600;text-decoration:none;box-sizing:border-box}
.et-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
a.et-chip:hover{border-color:#5A27E0;color:#5A27E0}
.et-chip.off{color:#94a3b8}
.et-bar{flex:none;display:flex;align-items:center;padding:8px 12px;background:#fff;border-bottom:1px solid #e6e8ee}
.et-back{display:inline-flex;align-items:center;gap:6px;border:1px solid #d0d5dd;background:#fff;border-radius:8px;padding:6px 12px;font:inherit;font-size:12.5px;font-weight:700;color:#344054;cursor:pointer}
.et-back:hover{border-color:#5A27E0;color:#5A27E0}
.et-back:focus-visible{outline:2px solid #5A27E0;outline-offset:2px}
.et-full{flex:1;min-height:0;overflow:auto;padding:14px 16px 20px;background:#fff}
.et-head{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;font-size:12.5px;padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid #e6e8ee}
.et-head dt{color:#64748b;font-weight:700}
.et-head dd{margin:0;overflow-wrap:anywhere}
.et-head dd.s{font-weight:800;color:#0f172a}
.et-body{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55;margin:0;font:inherit;font-size:13.5px;color:#1e293b}
.et-full .et-atts{margin-top:14px}
.et-msg{padding:24px 16px;color:#64748b}
`;

const raw = (id: string) => `/api/v1/documents/${id}/raw`;
const who = (a: ThreadAddr) => a.name || a.address || 'Unknown';
const full = (a: ThreadAddr) => (a.name && a.address ? `${a.name} <${a.address}>` : a.name || a.address || 'Unknown');
const dayKey = (iso: string | null) => (iso ? new Date(iso).toDateString() : '');
function dayLabel(iso: string | null): string {
  if (!iso) return 'Earlier';
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}
const timeOf = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
const longDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not Known');

function Attachments({ items }: { items: ThreadMsg['attachments'] }) {
  if (!items.length) return null;
  return (
    <div className="et-atts">
      {items.map((a, i) => a.documentId
        ? <a key={i} className="et-chip" href={raw(a.documentId)} target="_blank" rel="noopener noreferrer" title={a.name}><Paperclip size={16} /><span>{a.name}</span></a>
        : <span key={i} className="et-chip off" title={a.name}><Paperclip size={16} /><span>{a.name}</span></span>)}
    </div>
  );
}

/**
 * A filed email as the conversation it belongs to: bubbles, ours on the right, theirs on the
 * left, oldest at the top; opens on the email that raised the task. A bubble opens the full email.
 */
export function EmailThread({ matterId, documentId, onRead }: { matterId: string; documentId: string; onRead?: () => void }) {
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const bubbles = useRef(new Map<string, HTMLButtonElement>());
  const backBtn = useRef<HTMLButtonElement>(null);
  const saved = useRef<{ top: number; id: string } | null>(null);

  useEffect(() => {
    let live = true;
    setThread(null); setErr(null); setOpen(null); saved.current = null;
    api<ThreadView>(`/matters/${matterId}/emails/thread?documentId=${encodeURIComponent(documentId)}`)
      .then((t) => { if (live) setThread(t); })
      .catch((e: unknown) => { if (live) setErr(e instanceof Error ? e.message : 'Could not load the conversation.'); });
    return () => { live = false; };
  }, [matterId, documentId]);

  // First paint: the email that raised the task, at the bottom. Back from a message: where you were.
  useLayoutEffect(() => {
    if (!thread || open) return;
    const el = scroller.current;
    if (!el) return;
    if (saved.current) {
      el.scrollTop = saved.current.top;
      bubbles.current.get(saved.current.id)?.focus({ preventScroll: true });
      return;
    }
    const at = bubbles.current.get(documentId);
    const last = thread.messages[thread.messages.length - 1];
    if (!at || last?.id === documentId) el.scrollTop = el.scrollHeight;
    else at.scrollIntoView({ block: 'center' });
  }, [thread, open, documentId]);
  useEffect(() => { if (open) backBtn.current?.focus(); }, [open]);

  if (err) return <div className="et"><style>{CSS}</style><div className="eg-err" style={{ margin: 16 }}>{err}</div></div>;
  if (!thread) return <div className="et"><style>{CSS}</style><div className="et-msg"><Spin>Loading…</Spin></div></div>;

  const shown = open ? thread.messages.find((m) => m.id === open) ?? null : null;
  if (shown) {
    return (
      <div className="et">
        <style>{CSS}</style>
        <div className="et-bar">
          <button ref={backBtn} type="button" className="et-back" onClick={() => setOpen(null)}><ArrowLeft size={16} />Back To Conversation</button>
        </div>
        <div className="et-full">
          <dl className="et-head">
            <dt>From</dt><dd>{full(shown.from)}</dd>
            <dt>To</dt><dd>{shown.to.length ? shown.to.map(full).join(', ') : '—'}</dd>
            {shown.cc.length > 0 && <><dt>Cc</dt><dd>{shown.cc.map(full).join(', ')}</dd></>}
            <dt>Date</dt><dd>{longDate(shown.date)}</dd>
            <dt>Subject</dt><dd className="s">{shown.subject || '(No Subject)'}</dd>
          </dl>
          <pre className="et-body">{shown.body}</pre>
          <Attachments items={shown.attachments} />
        </div>
      </div>
    );
  }

  const openMsg = (id: string) => {
    saved.current = { top: scroller.current?.scrollTop ?? 0, id };
    onRead?.();
    setOpen(id);
  };
  return (
    <div className="et">
      <style>{CSS}</style>
      <div className="et-subj" title={thread.subject}>{thread.subject}</div>
      <div className="et-scroll" ref={scroller} role="log" aria-label="Conversation" onWheel={onRead} onTouchMove={onRead}>
        {thread.messages.map((m, i) => (
          <Fragment key={m.id}>
            {(i === 0 || dayKey(m.date) !== dayKey(thread.messages[i - 1].date)) && <div className="et-day">{dayLabel(m.date)}</div>}
            <div className={`et-row${m.mine ? ' mine' : ''}`}>
              <button
                type="button"
                ref={(el) => { if (el) bubbles.current.set(m.id, el); else bubbles.current.delete(m.id); }}
                className={`et-b${m.quoted ? ' quoted' : ''}${m.id === documentId ? ' at' : ''}`}
                aria-current={m.id === documentId ? 'true' : undefined}
                onClick={() => openMsg(m.id)}
              >
                <div className="et-who"><b>{who(m.from)}</b><time dateTime={m.date ?? undefined}>{timeOf(m.date)}</time></div>
                <div className="et-txt">{m.body || '(No Text)'}</div>
              </button>
              <Attachments items={m.attachments} />
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
