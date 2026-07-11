import { query, queryOne } from './db';
import { sendDraftMessage } from './graph';
import { writeAudit } from './audit';

/** How long an outbound email sits in the "scheduled" state before it actually sends —
 *  a soft grace window so a human can catch/cancel it before it leaves. Auto-sends (a
 *  workflow update email that fired without a person in the loop) get a longer window;
 *  a send a human just clicked only needs a brief "undo" window. */
export const SEND_DELAY_MIN = 20; // workflow / auto-send
export const MANUAL_SEND_DELAY_MIN = 2; // a human clicked Send

export type SendSource = 'MANUAL' | 'REPLY' | 'WORKFLOW';

export interface ScheduledSend {
  id: string;
  matter_id: string | null;
  subject: string | null;
  recipient: string | null;
  source: SendSource;
  scheduled_at: string;
}

/**
 * Park an already-created Outlook draft for deferred sending. Returns the row id and
 * the time it will go out. The draft stays in the user's Drafts until then, so a
 * cancel just abandons the schedule and leaves the draft for manual review/send.
 */
export async function scheduleSend(input: {
  tenantId: string;
  userId: string;
  matterId?: string | null;
  graphMessageId: string;
  subject?: string | null;
  recipient?: string | null;
  source: SendSource;
  delayMinutes?: number;
}): Promise<{ id: string; scheduledAt: string }> {
  const delay = input.delayMinutes ?? SEND_DELAY_MIN;
  const row = await queryOne<{ id: string; scheduled_at: string }>(
    `insert into scheduled_send (tenant_id, user_id, matter_id, graph_message_id, subject, recipient, source, scheduled_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' minutes')::interval)
     returning id, scheduled_at`,
    [input.tenantId, input.userId, input.matterId ?? null, input.graphMessageId, input.subject ?? null, input.recipient ?? null, input.source, String(delay)]
  );
  return { id: row!.id, scheduledAt: row!.scheduled_at };
}

/** Pending (not-yet-sent, not-cancelled) sends for a tenant, soonest first. */
export async function listScheduled(tenantId: string): Promise<ScheduledSend[]> {
  return query<ScheduledSend>(
    `select id, matter_id, subject, recipient, source, scheduled_at
       from scheduled_send
      where tenant_id = $1 and status = 'PENDING'
      order by scheduled_at asc`,
    [tenantId]
  );
}

/** Cancel a pending send. Returns true if a pending row was actually cancelled. */
export async function cancelScheduledSend(tenantId: string, id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update scheduled_send set status = 'CANCELLED'
      where id = $1 and tenant_id = $2 and status = 'PENDING'
      returning id`,
    [id, tenantId]
  );
  return !!row;
}

/**
 * Send everything whose time has come. Called by the cron backstop and opportunistically
 * whenever the worklist loads (so due sends still flush on a Hobby plan that can't run a
 * frequent cron). Scope to a tenant when driven by a user request; omit for the cron sweep.
 */
export async function processDueSends(tenantId?: string): Promise<{ checked: number; sent: number }> {
  const due = await query<{ id: string; tenant_id: string; user_id: string; graph_message_id: string; subject: string | null }>(
    `select id, tenant_id, user_id, graph_message_id, subject
       from scheduled_send
      where status = 'PENDING' and scheduled_at <= now()
        ${tenantId ? 'and tenant_id = $1' : ''}
      order by scheduled_at asc
      limit 50`,
    tenantId ? [tenantId] : []
  );

  let sent = 0;
  for (const row of due) {
    try {
      const res = await sendDraftMessage(row.user_id, row.graph_message_id);
      await query(`update scheduled_send set status = 'SENT', sent_at = now(), error = null where id = $1`, [row.id]);
      sent++;
      await writeAudit({
        tenantId: row.tenant_id,
        actorUserId: row.user_id,
        actionType: 'EMAIL_SENT',
        actionStatus: 'SUCCESS',
        payload: { source: 'SCHEDULED', subject: res.subject ?? row.subject },
      }).catch(() => {});
    } catch (e: any) {
      const msg = String(e?.message || e);
      // "no longer a draft" means it was already sent (or deleted) elsewhere — settle it,
      // don't keep retrying. Anything else is likely transient: leave PENDING for the next sweep.
      if (/no longer a draft/i.test(msg)) {
        await query(`update scheduled_send set status = 'SENT', sent_at = now() where id = $1`, [row.id]).catch(() => {});
      } else {
        await query(`update scheduled_send set error = $2 where id = $1`, [row.id, msg.slice(0, 500)]).catch(() => {});
      }
    }
  }
  return { checked: due.length, sent };
}
