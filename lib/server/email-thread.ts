/**
 * An email on a case as a conversation (docs/spec/ui.md): every email filed on the matter in the
 * same conversation, plus the older messages recovered from the quoted history inside them, oldest
 * first. Filed emails are `document` rows (doc_type EMAIL, content in extracted_facts.content,
 * newer ones also carry extracted_facts.email, see lib/server/files.ts fileEmailBodyAsDocument).
 *
 * The parsing below is pure and unit-tested (tests/unit/mail/email-thread.test.ts).
 */
import { query } from './db';
import { tenantSelfAddresses } from './matching';
import { stripQuotedReply } from './text';

export interface Addr { name: string | null; address: string | null }
export interface ThreadAttachment { name: string; documentId: string | null }
export interface ThreadMessage {
  id: string;
  documentId: string | null;
  from: Addr;
  to: Addr[];
  cc: Addr[];
  date: string | null;
  subject: string;
  body: string;
  attachments: ThreadAttachment[];
  mine: boolean;
  quoted: boolean;
}
export interface EmailThread { subject: string; messages: ThreadMessage[] }

/** What a quoted block says about the message it quotes. */
export interface QuotedMessage { from: Addr; to: Addr[]; cc: Addr[]; date: string | null; subject: string | null; body: string }

/** The thread key a subject gives: no Re:/Fw: prefixes, spacing or case. */
export function normaliseSubject(subject: string | null | undefined): string {
  let s = String(subject ?? '').trim();
  let prev = '';
  while (prev !== s) { prev = s; s = s.replace(/^\s*(?:re|fw|fwd|aw|sv|wg)\s*(?:\[\d+\])?\s*:\s*/i, ''); }
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** "Jane Smith <jane@x.com>", "\"Smith, Jane\" <jane@x.com>", "jane@x.com" or "Jane Smith [mailto:jane@x.com]". */
export function parseAddress(raw: string): Addr {
  const s = raw.trim().replace(/^\*+|\*+$/g, '').trim();
  const angle = s.match(/^(.*?)\s*[<[](?:mailto:)?([^\s<>[\]]+@[^\s<>[\]]+)[>\]]\s*$/i);
  if (angle) {
    const name = angle[1].trim().replace(/^["']|["']$/g, '').trim();
    return { name: name || null, address: angle[2].toLowerCase() };
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { name: null, address: s.toLowerCase() };
  return { name: s.replace(/^["']|["']$/g, '').trim() || null, address: null };
}

/** A header's address list, split on commas and semicolons outside quotes and angle brackets. */
export function parseAddressList(raw: string | null | undefined): Addr[] {
  const out: Addr[] = [];
  let cur = '';
  let quote = false;
  let angle = false;
  const push = () => { if (cur.trim()) out.push(parseAddress(cur)); cur = ''; };
  for (const ch of String(raw ?? '')) {
    if (ch === '"') quote = !quote;
    else if (ch === '<' || ch === '[') angle = true;
    else if (ch === '>' || ch === ']') angle = false;
    if ((ch === ',' || ch === ';') && !quote && !angle) {
      // "Smith, Jane" without quotes is one person: a part with no address and no @ joins the next.
      if (!/@/.test(cur) && cur.trim() && !/[<[]/.test(cur)) { cur += ch; continue; }
      push();
      continue;
    }
    cur += ch;
  }
  push();
  return out;
}

/** A date as written in a quoted header ("Monday, 28 September 2026 10:02", "Mon, 28 Sep 2026 at 10:02", "28/09/2026 10:02"), as ISO. */
export function parseLooseDate(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').replace(/\s+at\s+/i, ' ').replace(/\s+/g, ' ').trim().replace(/,$/, '');
  if (!s) return null;
  const uk = s.match(/^(?:[A-Za-z]+,?\s+)?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s*(?:(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (uk) {
    let h = Number(uk[4] ?? 0);
    if (uk[7]) h = (h % 12) + (/pm/i.test(uk[7]) ? 12 : 0);
    const y = Number(uk[3]) < 100 ? 2000 + Number(uk[3]) : Number(uk[3]);
    const d = new Date(y, Number(uk[2]) - 1, Number(uk[1]), h, Number(uk[5] ?? 0), Number(uk[6] ?? 0));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** A filed email written before extracted_facts.email existed: the header lines, then the body. */
export function parseLegacyEmail(content: string): { from: Addr; to: Addr[]; cc: Addr[]; date: string | null; subject: string; body: string } {
  const text = String(content ?? '').replace(/\r\n/g, '\n');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : '';
  const body = split >= 0 ? text.slice(split + 2) : text;
  const h: Record<string, string> = {};
  for (const line of head.split('\n')) {
    const m = line.match(/^([A-Za-z-]+):\s?(.*)$/);
    if (m) h[m[1].toLowerCase()] = m[2];
  }
  return {
    from: parseAddress(h.from ?? ''),
    to: parseAddressList(h.to),
    cc: parseAddressList(h.cc),
    date: h.date ? parseLooseDate(h.date) : null,
    subject: h.subject ?? '',
    body,
  };
}

// Outlook: "From: … / Sent: … / To: … / Cc: … / Subject: …" (optionally after "-----Original Message-----", headers sometimes bold as *From:*).
const OUTLOOK = /(^|\n)[ \t]*(?:-{2,}[ \t]*Original Message[ \t]*-{2,}[ \t]*\n[ \t]*)?\*?From:\*?[ \t]*([^\n]+)\n((?:[ \t]*\*?(?:Sent|Date|To|Cc|Subject)\*?:[^\n]*(?:\n|$)){1,6})/i;
// Gmail / Apple Mail: "On <date>, <name> <addr> wrote:", sometimes wrapped over two lines.
const GMAIL = /(^|\n)[ \t]*On[ \t]+([^\n]{4,200}?(?:\n(?![ \t]*>)[^\n]{0,120}?)?)[ \t]*wrote:[ \t]*(?=\n|$)/i;

function outlookHeaders(block: string): { to: Addr[]; cc: Addr[]; date: string | null; subject: string | null } {
  const out: { to: Addr[]; cc: Addr[]; date: string | null; subject: string | null } = { to: [], cc: [], date: null, subject: null };
  for (const line of block.split('\n')) {
    const m = line.match(/^[ \t]*\*?(Sent|Date|To|Cc|Subject)\*?:[ \t]*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === 'to') out.to = parseAddressList(m[2]);
    else if (k === 'cc') out.cc = parseAddressList(m[2]);
    else if (k === 'subject') out.subject = m[2].trim() || null;
    else out.date = parseLooseDate(m[2]);
  }
  return out;
}

/** "Mon, 28 Sep 2026 at 10:02, Jane Smith <jane@x.com>" → the date and the person. */
function gmailAttribution(raw: string): { from: Addr; date: string | null } {
  const s = raw.replace(/\s*\n\s*/g, ' ').replace(/<\s+/g, '<').replace(/\s+>/g, '>').trim();
  const withAddr = s.match(/^(.*?),?\s+([^,]*?)\s*<([^>]+@[^>]+)>\s*$/);
  if (withAddr) return { date: parseLooseDate(withAddr[1]), from: { name: withAddr[2].replace(/^["']|["']$/g, '').trim() || null, address: withAddr[3].toLowerCase() } };
  const bare = s.match(/^(.*?),?\s+(\S+@\S+)\s*$/);
  if (bare) return { date: parseLooseDate(bare[1]), from: { name: null, address: bare[2].toLowerCase() } };
  // "On 28 Sep 2026, at 10:02, Jane Smith": the name is after the last comma.
  const i = s.lastIndexOf(',');
  return i > 0 ? { date: parseLooseDate(s.slice(0, i)), from: { name: s.slice(i + 1).trim() || null, address: null } } : { date: null, from: { name: s, address: null } };
}

/**
 * An email body split into the words it adds and the messages it quotes, newest quoted first
 * (the order they appear). Works through nested history: each quoted message's own quoted part
 * becomes the next message.
 */
export function splitQuotedHistory(text: string, depth = 0): { fresh: string; history: QuotedMessage[] } {
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  if (depth > 25) return { fresh: t.trim(), history: [] };
  const o = OUTLOOK.exec(t);
  const g = GMAIL.exec(t);
  const oAt = o ? o.index + o[1].length : -1;
  const gAt = g ? g.index + g[1].length : -1;
  if (oAt < 0 && gAt < 0) return { fresh: t.trim(), history: [] };
  if (o && (gAt < 0 || oAt <= gAt)) {
    const fresh = t.slice(0, oAt).trimEnd().replace(/(^|\n)[ \t]*_{5,}[ \t]*$/, '').trim();
    const h = outlookHeaders(o[3]);
    const rest = t.slice(o.index + o[0].length);
    const sub = splitQuotedHistory(rest, depth + 1);
    return { fresh, history: [{ from: parseAddress(o[2]), to: h.to, cc: h.cc, date: h.date, subject: h.subject, body: sub.fresh }, ...sub.history] };
  }
  const m = g!;
  const fresh = t.slice(0, gAt).trim();
  const who = gmailAttribution(m[2]);
  const after = t.slice(m.index + m[0].length).replace(/^\n/, '');
  const lines = after.split('\n');
  let quotedBody: string;
  if (lines.some((l) => /^[ \t]*>/.test(l))) {
    const kept: string[] = [];
    for (const l of lines) {
      if (/^[ \t]*>/.test(l)) kept.push(l.replace(/^[ \t]*> ?/, ''));
      else if (!l.trim()) kept.push('');
      else if (kept.some((k) => k.trim())) break; // the quote ended: a signature or footer after it
    }
    quotedBody = kept.join('\n');
  } else quotedBody = after;
  const sub = splitQuotedHistory(quotedBody, depth + 1);
  return { fresh, history: [{ from: who.from, to: [], cc: [], date: who.date, subject: null, body: sub.fresh }, ...sub.history] };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Same sender and near-identical opening words: the same message. */
export function sameMessage(a: { from: Addr; body: string }, b: { from: Addr; body: string }): boolean {
  const aa = a.from.address?.toLowerCase();
  const ba = b.from.address?.toLowerCase();
  const sameSender = aa && ba ? aa === ba : !!a.from.name && !!b.from.name && norm(a.from.name) === norm(b.from.name);
  if (!sameSender) return false;
  const x = norm(a.body).slice(0, 80);
  const y = norm(b.body).slice(0, 80);
  if (!x || !y) return x === y;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 20 && long.startsWith(short);
}

export function isMine(from: Addr, self: { emails: Set<string>; domains: Set<string> }): boolean {
  const a = from.address?.toLowerCase();
  if (!a) return false;
  return self.emails.has(a) || self.domains.has(a.split('@')[1] ?? '');
}

/** A filed email row as the conversation reads it. */
export interface FiledEmailRow { id: string; created_at: string | Date; content: string | null; email: Record<string, any> | null }

interface Filed { msg: ThreadMessage; key: string; conversationId: string | null; raw: string }

export function filedMessage(row: FiledEmailRow, self: { emails: Set<string>; domains: Set<string> }): Filed {
  const legacy = parseLegacyEmail(row.content ?? '');
  const e = row.email ?? null;
  const addr = (r: any): Addr => ({ name: r?.name ?? null, address: r?.address ? String(r.address).toLowerCase() : null });
  const from = e?.from ? addr(e.from) : legacy.from;
  const subject = String(e?.subject ?? legacy.subject ?? '');
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  const date = (e?.date ? parseLooseDate(String(e.date)) : null) ?? legacy.date ?? created;
  const body = (typeof e?.fresh === 'string' && e.fresh.trim() ? e.fresh : stripQuotedReply(legacy.body)).trim();
  return {
    msg: {
      id: row.id,
      documentId: row.id,
      from,
      to: Array.isArray(e?.to) ? e.to.map(addr) : legacy.to,
      cc: Array.isArray(e?.cc) ? e.cc.map(addr) : legacy.cc,
      date,
      subject,
      body,
      attachments: Array.isArray(e?.attachments) ? e.attachments.map((a: any) => ({ name: String(a?.name ?? 'Attachment'), documentId: a?.documentId ?? null })) : [],
      mine: e?.direction === 'out' || isMine(from, self),
      quoted: false,
    },
    key: normaliseSubject(subject),
    conversationId: e?.conversationId ?? null,
    raw: legacy.body,
  };
}

/**
 * The conversation a filed email belongs to, from the matter's filed emails: members share the
 * conversation id, or (when either lacks one) the normalised subject. Quoted history recovered
 * from their bodies fills in what was never filed (our own replies, earlier messages).
 */
export function buildThread(rows: FiledEmailRow[], documentId: string, self: { emails: Set<string>; domains: Set<string> }): EmailThread | null {
  const all = rows.map((r) => filedMessage(r, self));
  const target = all.find((f) => f.msg.id === documentId);
  if (!target) return null;
  const members = all.filter((f) =>
    f === target
    || (f.conversationId && target.conversationId ? f.conversationId === target.conversationId : f.key === target.key && !!f.key));
  const messages: Array<ThreadMessage & { sortAt: number }> = members.map((f) => ({ ...f.msg, sortAt: Date.parse(f.msg.date ?? '') || 0 }));
  for (const f of members.slice().sort((a, b) => (Date.parse(a.msg.date ?? '') || 0) - (Date.parse(b.msg.date ?? '') || 0))) {
    const base = Date.parse(f.msg.date ?? '') || 0;
    const { history } = splitQuotedHistory(f.raw);
    history.forEach((q, i) => {
      if (!q.body.trim()) return;
      if (messages.some((m) => sameMessage(m, q))) return;
      const at = q.date ? Date.parse(q.date) : NaN;
      messages.push({
        id: `quoted-${f.msg.id}-${i}`,
        documentId: null,
        from: q.from,
        to: q.to,
        cc: q.cc,
        date: q.date,
        subject: q.subject ?? f.msg.subject,
        body: q.body.trim(),
        attachments: [],
        mine: isMine(q.from, self),
        quoted: true,
        // Undated: just before the message that quoted it, in the order quoted (newest first).
        sortAt: Number.isNaN(at) ? base - (i + 1) : at,
      });
    });
  }
  messages.sort((a, b) => a.sortAt - b.sortAt || (a.quoted === b.quoted ? 0 : a.quoted ? -1 : 1));
  return { subject: target.msg.subject.replace(/^\s*(?:(?:re|fw|fwd)\s*:\s*)+/i, '') || '(No Subject)', messages: messages.map(({ sortAt: _s, ...m }) => m) };
}

/** The conversation around one filed email on a matter. Null when the document is not an email on this matter. */
export async function emailThread(tenantId: string, matterId: string, documentId: string): Promise<EmailThread | null> {
  const rows = await query<FiledEmailRow>(
    `select id, created_at, extracted_facts->>'content' as content, extracted_facts->'email' as email
       from document
      where tenant_id = $1 and matter_id = $2 and (doc_type = 'EMAIL' or file_name ~ '^email-.*\\.txt$')
      order by created_at asc
      limit 500`,
    [tenantId, matterId]
  );
  const self = await tenantSelfAddresses(tenantId).catch(() => ({ emails: new Set<string>(), domains: new Set<string>() }));
  return buildThread(rows, documentId, self);
}
