import { query } from '../db';
import { readQueue, queueCounts, sweepForRead, recheckSenderAddress, enqueueMessage, QUEUE_PAGE, type QueueUser, type QueueRow } from './queue';
import { caseCards, explainMatch, senderOnCase } from './case-cards';
import { liveMatterIds } from '../matching';

/**
 * The filing queue as the Email page and the sidebar see it. Rows come from the
 * email_queue table (mail/queue.ts) — never from a live Graph list — so a busy mailbox
 * loses nothing and a badge costs one count. Case cards and the words that explain a
 * match are computed here because cases move on under the queue.
 */
export async function filingQueue(user: QueueUser, q: { cursor?: string | null; limit?: number; sweep?: boolean } = {}) {
  if (q.sweep !== false) await sweepForRead(user).catch((e) => console.warn('[filing queue] sweep failed', (e as Error).message));
  const [first, counts] = await Promise.all([readQueue(user, { cursor: q.cursor, limit: q.limit ?? QUEUE_PAGE }), queueCounts(user)]);
  let { rows, nextCursor } = first;
  // Flagged only because the name matches someone else on file: if a person has since said who this address is, check again.
  const nameOnly = [...new Set(rows.filter((r) => r.sender?.verdict === 'suspicious' && r.sender.warnings.length > 0 && r.sender.warnings.every((w) => /^Signed "/.test(w))).map((r) => r.from_address?.toLowerCase()).filter(Boolean))] as string[];
  if (nameOnly.length) {
    let changed = 0;
    for (const a of nameOnly) changed += await recheckSenderAddress(user.tenantId, a).catch(() => 0);
    if (changed) ({ rows, nextCursor } = await readQueue(user, { cursor: q.cursor, limit: q.limit ?? QUEUE_PAGE }));
  }

  const items = await shapeRows(user, rows);
  return { items, nextCursor, toFile: counts.toFile, bulk: counts.bulk };
}

/** Queue rows as the Email page shows them: live cases only, each with its case card and the words that explain the match. */
export async function shapeRows(user: QueueUser, rows: QueueRow[]) {
  // Suggestions are stored when the email is matched; a case abandoned or closed since is no longer offered.
  const allIds = rows.flatMap((r) => r.candidates.map((c) => c.matterId));
  const live = await liveMatterIds(user.tenantId, allIds).catch(() => new Set(allIds));
  const kept = rows.map((r) => ({ ...r, candidates: r.candidates.filter((c) => live.has(c.matterId)) }));
  const matterIds = kept.flatMap((r) => r.candidates.map((c) => c.matterId));
  const cards = await caseCards(user.tenantId, matterIds);
  const senders = [...new Set(kept.map((r) => r.from_address?.toLowerCase()).filter(Boolean))] as string[];
  const roles =
    matterIds.length && senders.length
      ? await query<{ matter_id: string; email: string; role: string }>(
          `select matter_id, lower(email) as email, role from matter_contact where tenant_id = $1 and matter_id = any($2::uuid[]) and lower(email) = any($3)`,
          [user.tenantId, [...new Set(matterIds)], senders]
        ).catch(() => [])
      : [];
  const roleOf = (matterId: string, email: string | null) => roles.find((r) => r.matter_id === matterId && r.email === email?.toLowerCase())?.role ?? null;

  const items = kept.map((r) => {
    // Equal scores: an open case before a closed one.
    const candidates = [...r.candidates].sort((a, b) => b.score - a.score || Number(!!cards.get(a.matterId)?.closed) - Number(!!cards.get(b.matterId)?.closed));
    return {
      id: r.graph_message_id,
      conversationId: r.graph_conversation_id,
      subject: r.subject ?? '(no subject)',
      from: { name: r.from_name, address: r.from_address },
      receivedDateTime: r.received_at,
      bodyPreview: r.body_preview ?? '',
      forwardedFrom: r.forwarded_from,
      notCaseMail: r.not_case_mail,
      hasAttachments: r.has_attachments,
      webLink: r.web_link,
      sender: r.sender,
      suggestions: candidates.map((c) => ({
        matterId: c.matterId,
        matterRef: c.matterRef,
        propertyAddress: c.propertyAddress,
        band: c.band,
        score: c.score,
        case: cards.get(c.matterId) ?? null,
        matched: explainMatch(c.signals, { fromName: r.from_name, fromAddress: r.from_address, senderRole: roleOf(c.matterId, r.from_address) }),
        senderOnCase: senderOnCase(c.signals, r.from_address),
        onThread: c.signals.some((x) => x.kind === 'LINKED_THREAD'),
      })),
    };
  });

  return items;
}

/**
 * One email as the Email page would show it, for Outlook's pane: filed already (to which case), or its suggestions. An
 * email not in the queue yet is matched now (deterministically, no model call) and queued.
 */
export async function queueItemFor(user: QueueUser, messageId: string, fetchMessage: () => Promise<any>) {
  const filed = async (conversationId: string | null) => (conversationId
    ? (await query<{ matter_id: string; matter_ref: string; property_address: string | null }>(
        `select t.matter_id, m.matter_ref, m.property_address from email_thread t join matter m on m.id = t.matter_id where t.tenant_id = $1 and t.graph_conversation_id = $2 limit 1`, [user.tenantId, conversationId]
      ))[0] ?? null
    : null);
  const row = async () => (await query<QueueRow>(
    `select id, graph_message_id, graph_conversation_id, subject, from_name, from_address, received_at, body_preview, forwarded_from, has_attachments, web_link, not_case_mail, sender, candidates
       from email_queue where tenant_id = $1 and mailbox_user_id = $2 and graph_message_id = $3 order by created_at desc limit 1`, [user.tenantId, user.userId, messageId]
  ))[0] ?? null;
  let r = await row();
  if (r?.graph_conversation_id) { const f = await filed(r.graph_conversation_id); if (f) return { filed: { matterId: f.matter_id, matterRef: f.matter_ref, propertyAddress: f.property_address }, item: null }; }
  if (!r) {
    const m = await fetchMessage();
    const f = await filed(m?.conversationId ?? null);
    if (f) return { filed: { matterId: f.matter_id, matterRef: f.matter_ref, propertyAddress: f.property_address }, item: null };
    await enqueueMessage(user, m).catch(() => false);
    r = await row();
  }
  if (!r) return { filed: null, item: null };
  return { filed: null, item: (await shapeRows(user, [r]))[0] };
}

/**
 * What the sidebar shows: case mail to file, the whole queue, not a page of it. The
 * badge also keeps the queue filled — the backlog sweep the first time a mailbox is
 * seen, then one page of the newest mail at most every five minutes — so a firm that
 * never opens the Email page still sees the number climb as mail arrives.
 */
export async function toFileCount(user: QueueUser): Promise<number> {
  await sweepForRead(user, { throttleMs: 5 * 60_000 }).catch((e) => console.warn('[nav counts] sweep failed', (e as Error).message));
  return (await queueCounts(user)).toFile;
}
