/**
 * "Chase up" — surfacing matters where the firm is the one waiting.
 *
 * Triage answers "what does this INCOMING email need?". Chasing is the mirror: an
 * OUTBOUND thread that's gone quiet. A thread is a chase when it's matched to an OPEN
 * matter, the LATEST message in the conversation was sent BY the firm (a self-address —
 * see tenantSelfAddresses), and no reply has arrived within config.chaseSlaDays. It clears
 * itself the moment a reply lands (the latest message becomes inbound) or the user snoozes.
 *
 * The live "who sent last" truth is Microsoft Graph (the conversation, which spans Sent
 * Items). Because that's a Graph call per thread, a background SWEEP does it and PERSISTS
 * the verdict onto email_thread; the taskpane worklist then reads cheap, stored state.
 *
 *   - runChaseSweep()  — (re)scans each open matter's threads via Graph, persists
 *     chase_awaiting_since, and — for overdue ones — stamps a follow-up FLAG (due today) +
 *     a "Chase up" category on the awaiting message, so it shows in Outlook's To-Do bar /
 *     Flagged view / To-Do "My Day". The Graph scan + persist runs for any entitled tenant;
 *     writing flags to the mailbox is premium (automation, à la auto-PROCESS).
 *   - detectChases() — the read worklist for the taskpane "To chase" home tab. Pure DB read
 *     of the persisted state; no Graph, no writes.
 */
import { query } from './db';
import { config } from './config';
import { tenantSelfAddresses } from './matching';
import { listThreadMessages, ensureMasterCategory, addMessageCategories, setFollowUpFlag } from './graph';
import { isPremiumTenant, isEntitled } from './plan';

export const CHASE_CATEGORY = 'Chase up';
// Don't re-hit Graph for a thread more often than this (the sweep runs on every taskpane
// open and daily), and cap how many threads one sweep scans, so a big backlog can't make
// an open slow or hammer Graph.
const CHASE_RECHECK_HOURS = 6;
const CHASE_SCAN_CAP = 150;

export interface ChaseItem {
  threadId: string;
  graphThreadId: string;
  matterId: string;
  matterRef: string;
  propertyAddress: string | null;
  subject: string | null;
  awaitingSince: string; // ISO — when the unanswered outbound message went out
  ageDays: number; // whole days the ball has sat in the other side's court
}

/**
 * The threads currently needing a chase for a tenant, most overdue first. Pure DB read of
 * the state the sweep persisted — fast, no Graph. `slaDays` defaults to config.
 */
export async function detectChases(tenantId: string, slaDays = config.chaseSlaDays): Promise<ChaseItem[]> {
  const rows = await query<{
    thread_id: string;
    graph_thread_id: string;
    matter_id: string;
    matter_ref: string;
    property_address: string | null;
    subject: string | null;
    chase_awaiting_since: string;
  }>(
    `select t.id as thread_id, t.graph_thread_id, t.subject, t.chase_awaiting_since,
            m.id as matter_id, m.matter_ref, m.property_address
       from email_thread t
       join matter m on m.id = t.matter_id
      where t.tenant_id = $1
        and m.status = 'OPEN'
        and t.chase_awaiting_since is not null
        and t.chase_awaiting_since < now() - ($2 || ' days')::interval
        and coalesce(t.chase_snoozed_until, to_timestamp(0)) < now()
      order by t.chase_awaiting_since asc`,
    [tenantId, String(slaDays)]
  );
  const now = Date.now();
  return rows.map((r) => ({
    threadId: r.thread_id,
    graphThreadId: r.graph_thread_id,
    matterId: r.matter_id,
    matterRef: r.matter_ref,
    propertyAddress: r.property_address,
    subject: r.subject,
    awaitingSince: r.chase_awaiting_since,
    ageDays: Math.floor((now - new Date(r.chase_awaiting_since).getTime()) / 86_400_000),
  }));
}

const domainOf = (addr: string): string => (addr.includes('@') ? addr.split('@')[1] : '');

/**
 * Re-scan the tenant's open-matter threads via Graph, persist who-sent-last, and flag the
 * overdue ones natively in Outlook (premium). Throttled (skips threads seen in the last
 * CHASE_RECHECK_HOURS) and capped (CHASE_SCAN_CAP threads/run). Best-effort; returns the
 * number of threads (re)flagged.
 */
export async function runChaseSweep(userId: string, tenantId: string): Promise<number> {
  if (!(await isEntitled(tenantId))) return 0;
  const self = await tenantSelfAddresses(tenantId);
  if (self.emails.size === 0 && self.domains.size === 0) return 0;

  const threads = await query<{
    id: string;
    conversation_id: string | null;
    snoozed_until: string | null;
    flagged_at: string | null;
  }>(
    `select t.id, coalesce(t.graph_conversation_id, t.graph_thread_id) as conversation_id,
            t.chase_snoozed_until as snoozed_until, t.chase_flagged_at as flagged_at
       from email_thread t
       join matter m on m.id = t.matter_id
      where t.tenant_id = $1 and m.status = 'OPEN'
        and coalesce(t.chase_checked_at, to_timestamp(0)) < now() - interval '${CHASE_RECHECK_HOURS} hours'
      order by t.chase_checked_at asc nulls first
      limit ${CHASE_SCAN_CAP}`,
    [tenantId]
  );
  if (threads.length === 0) return 0;

  const premium = await isPremiumTenant(tenantId);
  const slaMs = config.chaseSlaDays * 86_400_000;
  let ensured = false;
  let flagged = 0;

  for (const t of threads) {
    if (!t.conversation_id) {
      await query(`update email_thread set chase_checked_at = now() where id = $1`, [t.id]).catch(() => {});
      continue;
    }
    let awaitingSince: string | null = null;
    let lastMessageId: string | null = null;
    try {
      const msgs = await listThreadMessages(userId, t.conversation_id); // chronological asc
      const last = msgs[msgs.length - 1];
      const from = last?.from?.emailAddress?.address?.toLowerCase() as string | undefined;
      const outbound = !!from && (self.emails.has(from) || self.domains.has(domainOf(from)));
      if (outbound) {
        awaitingSince = (last.sentDateTime ?? last.receivedDateTime) || null;
        lastMessageId = last.id ?? null;
      }
    } catch {
      // Can't read this conversation right now — just bump checked_at and move on.
      await query(`update email_thread set chase_checked_at = now() where id = $1`, [t.id]).catch(() => {});
      continue;
    }

    await query(
      `update email_thread
          set chase_awaiting_since = $2, chase_last_message_id = $3, chase_checked_at = now()
        where id = $1`,
      [t.id, awaitingSince, lastMessageId]
    ).catch(() => {});

    // Last message is now an outbound SENT one → any reply we'd drafted for this thread has
    // been sent, so clear its "ready to send" worklist item (it now becomes a chase instead).
    // Inlined rather than importing worklist.ts (which imports chase.ts) to avoid a cycle.
    if (awaitingSince) {
      await query(
        `update worklist_item set done_at = now()
          where tenant_id = $1 and kind = 'DRAFT_READY' and thread_id = $2 and done_at is null`,
        [tenantId, t.id]
      ).catch(() => {});
    }

    // Flag it natively in Outlook when it's overdue, not snoozed, and we haven't already
    // flagged this same outbound message. Premium only.
    if (!premium || !awaitingSince || !lastMessageId) continue;
    const overdue = Date.now() - new Date(awaitingSince).getTime() >= slaMs;
    const snoozed = t.snoozed_until && new Date(t.snoozed_until).getTime() > Date.now();
    const alreadyFlagged = t.flagged_at && new Date(t.flagged_at).getTime() >= new Date(awaitingSince).getTime();
    if (!overdue || snoozed || alreadyFlagged) continue;
    try {
      if (!ensured) {
        await ensureMasterCategory(userId, CHASE_CATEGORY, 'preset1').catch(() => {}); // preset1 = orange
        ensured = true;
      }
      await setFollowUpFlag(userId, lastMessageId);
      await addMessageCategories(userId, lastMessageId, [CHASE_CATEGORY]);
      await query(`update email_thread set chase_flagged_at = now() where id = $1`, [t.id]);
      flagged += 1;
    } catch {
      /* a moved/deleted message can 404 — leave it for the next sweep */
    }
  }
  return flagged;
}

/** Snooze a chase so it drops off the list (and won't be re-flagged) until `until`. */
export async function snoozeChase(tenantId: string, threadId: string, until: Date): Promise<void> {
  await query(`update email_thread set chase_snoozed_until = $3 where tenant_id = $1 and id = $2`, [
    tenantId,
    threadId,
    until.toISOString(),
  ]);
}
