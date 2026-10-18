/**
 * InTouch, between syncs (docs/intouch-integration.md "Polling"). InTouch has no webhook for a new file, so:
 *
 * - every 15 minutes, each live mirrored case's newest folder page is read, and what is new is mirrored and read as the
 *   daily sync would (`pollFolders`);
 * - every minute, the cases an unfiled email might belong to (its candidates in the Email tab's queue) are checked for
 *   an email a person filed in InTouch (InTouch's Outlook add-in): that email is then filed to the same case here,
 *   from the mailbox, and leaves the queue (`pickUpFiledEmails`). Filed once, in either place.
 *
 * Both are bounded by time and case count and do nothing for a firm without InTouch.
 */
import { query, queryOne, runAsSystem } from '../../db';
import type { SessionUser } from '../../types';
import { applyCaseFacts, type InTouchSyncDeps } from './sync';
import type { InTouchSyncSummary } from './types';

const empty = (): InTouchSyncSummary => ({ cases: 0, created: 0, parties: 0, documents: 0, milestones: 0, skipped: 0, errors: [] });

/** The newest page of each live mirrored case's folder (most recently active first, at most `maxCases`, within `budgetMs`). */
export async function pollFolders(deps: InTouchSyncDeps, tenantId: string, opts: { maxCases?: number; budgetMs?: number } = {}): Promise<InTouchSyncSummary> {
  const out = empty();
  const started = Date.now();
  const cases = await runAsSystem(() => query<{ id: string; intouch_case_id: string; intouch_milestone: string | null }>(
    `select id, intouch_case_id, intouch_milestone from matter
      where tenant_id = $1 and intouch_case_id is not null and status <> 'CLOSED' and coalesce(updated_at, created_at) > now() - interval '60 days'
      order by coalesce(updated_at, created_at) desc limit $2`, [tenantId, opts.maxCases ?? 150]
  ));
  for (const c of cases) {
    if (Date.now() - started > (opts.budgetMs ?? 45_000)) break;
    try {
      await applyCaseFacts(deps, tenantId, { matterId: c.id, intouchCaseId: c.intouch_case_id, lastMilestone: c.intouch_milestone }, out, { newestOnly: true });
      out.cases += 1;
    } catch (err) {
      out.errors.push(`case ${c.intouch_case_id}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** "RE: FW: Searches" and "Searches" are the same conversation's subject. */
export const sameSubject = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const n = (s: string | null | undefined) => (s ?? '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return !!n(a) && n(a) === n(b);
};

export interface QueuedEmail { id: string; mailboxUserId: string; messageId: string; conversationId: string | null; subject: string | null; from: string | null; receivedAt: string | null }

/**
 * Which queued email an InTouch email record is: the same subject, from the same sender where InTouch says, received
 * before it was filed (and within the week before). Ambiguous (two equally good) is none: nothing is filed on a guess.
 */
export function matchQueued(rec: { at: string | null; subject: string | null; from: string | null }, queued: QueuedEmail[]): QueuedEmail | null {
  const at = rec.at ? Date.parse(rec.at) : null;
  const hits = queued.filter((q) => {
    if (!sameSubject(q.subject, rec.subject)) return false;
    if (rec.from && q.from && rec.from !== q.from.toLowerCase()) return false;
    if (at != null && q.receivedAt) { const r = Date.parse(q.receivedAt); if (r > at + 5 * 60_000 || r < at - 7 * 86_400_000) return false; }
    return true;
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Emails a person filed in InTouch, filed here too: for each case an unfiled email might belong to, its newest email
 * records; one matching an unfiled email is filed to that case from the mailbox (its attachments read as any filed
 * email's are), and the conversation leaves the queue.
 */
export async function pickUpFiledEmails(
  tenantId: string,
  api: { folderEmails(caseId: string): Promise<Array<{ id: string; at: string | null; subject: string | null; from: string | null }>> },
  file: (owner: SessionUser, q: QueuedEmail, matterId: string) => Promise<void>,
  opts: { budgetMs?: number } = {},
): Promise<{ checked: number; filed: number }> {
  const started = Date.now();
  const queued = await runAsSystem(() => query<{ id: string; mailbox_user_id: string; graph_message_id: string; graph_conversation_id: string | null; subject: string | null; from_address: string | null; received_at: Date | null; candidates: Array<{ matterId?: string }> | null }>(
    `select id, mailbox_user_id, graph_message_id, graph_conversation_id, subject, from_address, received_at, candidates from email_queue
      where tenant_id = $1 and resolved_at is null and created_at > now() - interval '3 days' order by created_at desc limit 200`, [tenantId]
  )).catch(() => []);
  if (!queued.length) return { checked: 0, filed: 0 };
  const asQueued = (r: (typeof queued)[number]): QueuedEmail => ({ id: r.id, mailboxUserId: r.mailbox_user_id, messageId: r.graph_message_id, conversationId: r.graph_conversation_id, subject: r.subject, from: r.from_address, receivedAt: r.received_at?.toISOString() ?? null });
  // The cases these emails might belong to, mirrored from InTouch.
  const candidateIds = [...new Set(queued.flatMap((q) => (q.candidates ?? []).map((c) => c.matterId).filter((x): x is string => !!x)))];
  if (!candidateIds.length) return { checked: 0, filed: 0 };
  const cases = await runAsSystem(() => query<{ id: string; intouch_case_id: string }>(
    `select id, intouch_case_id from matter where tenant_id = $1 and id = any($2::uuid[]) and intouch_case_id is not null limit 30`, [tenantId, candidateIds]
  ));
  let checked = 0, filed = 0;
  const left = queued.map(asQueued);
  for (const c of cases) {
    if (Date.now() - started > (opts.budgetMs ?? 40_000)) break;
    checked += 1;
    const records = await api.folderEmails(c.intouch_case_id).catch(() => []);
    for (const rec of records) {
      const seen = await runAsSystem(() => queryOne<{ id: string }>(`select id from intouch_applied where tenant_id = $1 and kind = 'email_in' and external_id = $2`, [tenantId, rec.id])).catch(() => null);
      if (seen) continue;
      const q = matchQueued(rec, left);
      if (!q) continue;
      const owner = await runAsSystem(() => queryOne<{ id: string; tenant_id: string; role: SessionUser['role']; email: string; display_name: string | null }>(`select id, tenant_id, role, email, display_name from app_user where id = $1`, [q.mailboxUserId]));
      if (!owner) continue;
      try {
        await file({ userId: owner.id, tenantId: owner.tenant_id, role: owner.role, email: owner.email, displayName: owner.display_name }, q, c.id);
        await runAsSystem(() => query(`insert into intouch_applied (tenant_id, matter_id, kind, external_id, detail) values ($1,$2,'email_in',$3,$4) on conflict do nothing`, [tenantId, c.id, rec.id, q.messageId]));
        left.splice(left.indexOf(q), 1);
        filed += 1;
      } catch (err) {
        console.warn('[intouch] email filed in InTouch not filed here', (err as Error).message);
      }
    }
  }
  return { checked, filed };
}
