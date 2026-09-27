'use client';
import type { ProposalPreview } from './types';

/** What a proposal would actually do, as the thing itself: the email or WhatsApp message and who it goes to, the form, or the order. */
export const PROPOSAL_MESSAGE_CSS = `
.pm{border:1px solid #e6e8ee;border-radius:12px;background:#fff;padding:12px 14px;margin:10px 0}
.pm.warn{border-color:#fbbf24;background:#fffbeb}
.pm .h{font-size:13px;font-weight:700;color:#0f172a}
.pm .s{margin-top:8px;font-size:13.5px;font-weight:700;color:#0f172a}
.pm .b{margin:6px 0 0;font:inherit;font-size:13.5px;line-height:1.55;color:#0f172a;white-space:pre-wrap}
.pm p{margin:6px 0 0;font-size:13px;color:#475569}
.pm p.warn{color:#92400e}
`;

export function ProposalMessage({ msg }: { msg: ProposalPreview }) {
  if (msg.kind === 'action') {
    return (
      <div className="pm" aria-label="What would be done">
        <div className="h">{msg.title}</div>
        {msg.lines.map((l, i) => <p key={i}>{l}</p>)}
      </div>
    );
  }
  const none = msg.channel === 'none';
  return (
    <div className={`pm${none ? ' warn' : ''}`} aria-label="What would be sent">
      <div className="h">{msg.kind === 'form' ? 'The proof-of-funds form goes to' : msg.channel === 'whatsapp' ? 'WhatsApp to' : msg.channel === 'draft' ? 'Email drafted in Outlook to' : 'Email to'} {msg.to}</div>
      {none && <p className="warn">There is no address for them on the case, so this cannot go until one is added.</p>}
      <div className="s">{msg.subject}</div>
      <pre className="b">{msg.body}</pre>
    </div>
  );
}
