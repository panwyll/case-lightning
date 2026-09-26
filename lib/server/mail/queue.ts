/**
 * The filing queue's storage (migration 081). Three writers, two readers.
 *
 * Writers: the Graph notification handler enqueues every inbound message it cannot file
 * on a trusted link; sweepInbox() pages the mailbox to fill the backlog and to catch what
 * a lapsed subscription missed; link-thread and not-a-case resolve rows by conversation.
 * Readers: readQueue() for the Email page, queueCounts() for the sidebar badge. Both are
 * plain table reads — no Graph call, no model call, no matching at read time.
 *
 * What a row carries is decided ONCE at enqueue: the sender check, the best case matches
 * (deterministic matching), and whether it is bulk mail. Case cards and the words
 * explaining a match are computed at read time because cases change under the queue.
 */
import { query, queryOne } from '../db';
import { listInboxMessages } from '../graph';
import { matchMessage, type Candidate as MatchCandidate } from '../matching';
import { checkSender, type SenderCheck, type KnownParties } from './sender-check';
import { knownParties } from './known-parties';
import { bulkReason, readablePreview } from './bulk';

export interface QueueUser {
  userId: string;
  tenantId: string;
}

/** Rows a single read returns; the page asks for more with a cursor. */
export const QUEUE_PAGE = 50;
/** Inbox pages (of 25) the one-off backlog sweep will read — about a day and a half of a busy mailbox. */
const BACKLOG_PAGES = 12;

type GraphMessage = Record<string, any>;

function senderOf(m: GraphMessage, known: KnownParties): SenderCheck {
  return checkSender(
    {
      fromName: m.from?.emailAddress?.name ?? null,
      fromAddress: m.from?.emailAddress?.address ?? null,
      replyTo: (m.replyTo ?? []).map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address).filter(Boolean),
      headers: Array.isArray(m.internetMessageHeaders) ? m.internetMessageHeaders : null,
    },
    known
  );
}

/** Which conversations in a set are already on a case or set aside. */
async function alreadyHandled(tenantId: string, conversationIds: string[]): Promise<Set<string>> {
  if (!conversationIds.length) return new Set();
  const [filed, aside] = await Promise.all([
    query<{ graph_conversation_id: string }>(
      `select graph_conversation_id from email_thread where tenant_id = $1 and graph_conversation_id = any($2::text[])`,
      [tenantId, conversationIds]
    ).catch(() => []),
    query<{ graph_conversation_id: string }>(
      `select graph_conversation_id from email_not_filed where tenant_id = $1 and graph_conversation_id = any($2::text[])`,
      [tenantId, conversationIds]
    ).catch(() => []),
  ]);
  return new Set([...filed, ...aside].map((r) => r.graph_conversation_id));
}

/**
 * Put one inbound message on the queue. Idempotent on (tenant, message id). Pass the
 * triage's candidates and classification when you have them so the matching and the
 * "is this about a property at all" verdict are not recomputed.
 */
export async function enqueueMessage(
  user: QueueUser,
  m: GraphMessage,
  opts: { candidates?: MatchCandidate[]; sender?: SenderCheck; caseMail?: 'yes' | 'no' | null; caseMailWhat?: string | null; known?: KnownParties } = {}
): Promise<boolean> {
  if (!m?.id) return false;
  const conversationId: string | null = m.conversationId ?? null;
  if (conversationId && (await alreadyHandled(user.tenantId, [conversationId])).has(conversationId)) return false;

  const known = opts.known ?? (await knownParties(user.tenantId));
  const sender = opts.sender ?? senderOf(m, known);
  const fromAddress: string | null = m.from?.emailAddress?.address ?? null;
  const candidates =
    opts.candidates ??
    (await matchMessage(
      user.tenantId,
      {
        conversationId: m.conversationId,
        fromAddress: fromAddress ?? undefined,
        recipientAddresses: (m.toRecipients ?? []).map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address).filter(Boolean),
        subject: m.subject ?? '',
        bodyText: String(m.body?.content ?? m.bodyPreview ?? '').slice(0, 20_000),
      },
      { distrustSender: sender.verdict === 'suspicious' }
    ).catch(() => []));
  const top3 = candidates.slice(0, 3);

  // The AI's read of the email, when the caller didn't pass it: the triage row already paid for.
  let aiNot: string | null = null;
  if (opts.caseMail === 'no') aiNot = opts.caseMailWhat || 'not about a property transaction';
  else if (opts.caseMail === undefined) {
    const t = await queryOne<{ case_mail: string | null; what: string | null }>(
      `select classification->>'caseMail' as case_mail, classification->>'caseMailWhat' as what
         from email_triage where tenant_id = $1 and graph_message_id = $2 order by created_at desc limit 1`,
      [user.tenantId, m.id]
    ).catch(() => null);
    if (t?.case_mail === 'no') aiNot = t.what || 'not about a property transaction';
  }
  const headers = Array.isArray(m.internetMessageHeaders) ? m.internetMessageHeaders : null;
  const bulk = bulkReason({ headers, fromAddress }) ?? aiNot;
  const notCaseMail = bulk && !top3.some((c) => c.band === 'AUTO' || c.band === 'STRONG') ? bulk : null;
  const { preview, forwardedFrom } = readablePreview(m.body?.content, m.bodyPreview ?? '');

  const row = await queryOne<{ id: string }>(
    `insert into email_queue
       (tenant_id, mailbox_user_id, graph_message_id, graph_conversation_id, subject, from_name, from_address,
        received_at, body_preview, forwarded_from, has_attachments, web_link, not_case_mail, sender, candidates)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)
     on conflict (tenant_id, graph_message_id) do nothing
     returning id`,
    [
      user.tenantId,
      user.userId,
      m.id,
      conversationId,
      m.subject ?? null,
      m.from?.emailAddress?.name ?? null,
      fromAddress,
      m.receivedDateTime ?? null,
      preview,
      /^\s*(fw|fwd)\s*:/i.test(m.subject ?? '') ? forwardedFrom : null,
      !!m.hasAttachments,
      m.webLink ?? null,
      notCaseMail,
      JSON.stringify(notCaseMail ? { verdict: sender.verdict === 'suspicious' ? 'unverified' : sender.verdict, warnings: [] } : sender),
      JSON.stringify(top3),
    ]
  );
  return !!row;
}

/**
 * Page the inbox and enqueue what is not on the queue yet. `pages` inbox pages of 25,
 * newest first; stops early on a page that added nothing once the backlog is in.
 */
export async function sweepInbox(user: QueueUser, opts: { pages: number; stopWhenNothingNew?: boolean }): Promise<number> {
  let nextLink: string | null = null;
  let added = 0;
  const known = await knownParties(user.tenantId);
  for (let p = 0; p < opts.pages; p++) {
    const page: { messages: GraphMessage[]; nextLink: string | null } = await listInboxMessages(user.userId, { top: 25, nextLink, withBody: true });
    const messages = page.messages;
    if (!messages.length) break;
    const ids = messages.map((m) => m.id as string);
    const seen = new Set(
      (
        await query<{ graph_message_id: string }>(
          `select graph_message_id from email_queue where tenant_id = $1 and graph_message_id = any($2::text[])`,
          [user.tenantId, ids]
        )
      ).map((r) => r.graph_message_id)
    );
    const handled = await alreadyHandled(user.tenantId, [...new Set(messages.map((m) => m.conversationId).filter(Boolean))] as string[]);
    const selfAddr = await selfAddress(user.userId);
    let addedThisPage = 0;
    for (const m of messages) {
      if (seen.has(m.id)) continue;
      if (m.conversationId && handled.has(m.conversationId)) continue;
      // The mailbox owner's own sent mail cc'd back in is not something to file from here.
      if (selfAddr && (m.from?.emailAddress?.address ?? '').toLowerCase() === selfAddr) continue;
      if (await enqueueMessage(user, m, { known }).catch(() => false)) addedThisPage++;
    }
    added += addedThisPage;
    if (opts.stopWhenNothingNew && addedThisPage === 0) break;
    nextLink = page.nextLink;
    if (!nextLink) break;
  }
  return added;
}

async function selfAddress(userId: string): Promise<string> {
  const r = await queryOne<{ email: string | null }>(`select email from app_user where id = $1`, [userId]).catch(() => null);
  return (r?.email ?? '').toLowerCase();
}

/**
 * Keep the queue honest on each page load: the one-off backlog sweep the first time a
 * mailbox is seen, then one page of the newest mail every time — the subscription should
 * have delivered it, but a lapsed subscription must not mean a silent hole.
 */
export async function sweepForRead(user: QueueUser, opts: { throttleMs?: number } = {}): Promise<void> {
  const s = await queryOne<{ full_swept_at: string | null; recent_swept_at: string | null }>(
    `select full_swept_at, recent_swept_at from email_queue_sweep where tenant_id = $1 and user_id = $2`,
    [user.tenantId, user.userId]
  ).catch(() => null);
  if (!s?.full_swept_at) {
    await sweepInbox(user, { pages: BACKLOG_PAGES });
    await query(
      `insert into email_queue_sweep (tenant_id, user_id, full_swept_at, recent_swept_at) values ($1,$2,now(),now())
       on conflict (tenant_id, user_id) do update set full_swept_at = now(), recent_swept_at = now()`,
      [user.tenantId, user.userId]
    );
    return;
  }
  // The badge asks on every shell load; one Graph page every few minutes is plenty there.
  if (opts.throttleMs && s.recent_swept_at && Date.now() - new Date(s.recent_swept_at).getTime() < opts.throttleMs) return;
  await sweepInbox(user, { pages: 1 });
  await query(`update email_queue_sweep set recent_swept_at = now() where tenant_id = $1 and user_id = $2`, [user.tenantId, user.userId]);
}

/** A thread went on a case, or was set aside: its rows leave the queue. */
export async function resolveConversation(
  tenantId: string,
  conversationId: string,
  resolution: 'FILED' | 'SET_ASIDE',
  matterId: string | null = null
): Promise<void> {
  await query(
    `update email_queue set resolved_at = now(), resolution = $3, resolved_matter_id = $4
      where tenant_id = $1 and graph_conversation_id = $2 and resolved_at is null`,
    [tenantId, conversationId, resolution, matterId]
  );
}

/** Undo a set-aside: the thread returns to the queue. */
export async function reopenConversation(tenantId: string, conversationId: string): Promise<void> {
  await query(
    `update email_queue set resolved_at = null, resolution = null, resolved_matter_id = null
      where tenant_id = $1 and graph_conversation_id = $2 and resolution = 'SET_ASIDE'`,
    [tenantId, conversationId]
  );
}

export interface QueueRow {
  id: string;
  graph_message_id: string;
  graph_conversation_id: string | null;
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  received_at: string | null;
  body_preview: string | null;
  forwarded_from: string | null;
  has_attachments: boolean;
  web_link: string | null;
  not_case_mail: string | null;
  sender: { verdict: 'ok' | 'unverified' | 'suspicious'; warnings: string[] };
  candidates: MatchCandidate[];
}

/** One page of open rows, newest first. `cursor` is the last row's received_at|id. */
export async function readQueue(user: QueueUser, opts: { cursor?: string | null; limit?: number } = {}): Promise<{ rows: QueueRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? QUEUE_PAGE, 5), 200);
  const [cAt, cId] = opts.cursor ? opts.cursor.split('|') : [null, null];
  const rows = await query<QueueRow>(
    `select id, graph_message_id, graph_conversation_id, subject, from_name, from_address, received_at, body_preview,
            forwarded_from, has_attachments, web_link, not_case_mail, sender, candidates
       from email_queue
      where tenant_id = $1 and mailbox_user_id = $2 and resolved_at is null
        and ($3::timestamptz is null or (received_at, id) < ($3::timestamptz, $4::uuid))
      order by received_at desc, id desc
      limit $5`,
    [user.tenantId, user.userId, cAt, cId, limit + 1]
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > limit && last ? `${last.received_at}|${last.id}` : null };
}

/** The badge and the header: case mail to file, and bulk set apart. */
export async function queueCounts(user: QueueUser): Promise<{ toFile: number; bulk: number }> {
  const r = await queryOne<{ to_file: number; bulk: number }>(
    `select count(*) filter (where not_case_mail is null)::int as to_file,
            count(*) filter (where not_case_mail is not null)::int as bulk
       from email_queue where tenant_id = $1 and mailbox_user_id = $2 and resolved_at is null`,
    [user.tenantId, user.userId]
  );
  return { toFile: r?.to_file ?? 0, bulk: r?.bulk ?? 0 };
}
