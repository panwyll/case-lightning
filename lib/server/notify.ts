import { query, queryOne } from './db';
import { createDraftMessage, sendDraftMessage } from './graph';

/** Batching windows so a burst of activity becomes ONE briefing, and we never hammer:
 *  - hold a person's notifications until things go quiet (no new ping for QUIET_MIN), OR
 *  - send anyway once the oldest has waited MAX_HOLD_MIN (don't sit on it forever).
 *  Stale pending items (e.g. a fee-earner who never reconnected Outlook) are dropped. */
const QUIET_MIN = 3;
const MAX_HOLD_MIN = 20;
const STALE_HOURS = 6;

export type NotifyKind = 'STATUS_CHANGED' | 'DOC_RECEIVED' | 'EMAIL_TRIAGED';

export interface NotifyInput {
  tenantId: string;
  userId: string; // recipient — the matter's fee-earner
  matterId?: string | null;
  matterRef?: string | null;
  kind: NotifyKind;
  headline: string; // what came up
  did?: string | null; // what CONVEYi already did about it
  action?: string | null; // the one thing the human needs to do
  dedupKey?: string | null; // collapse repeat pings on the same matter+kind while still pending
}

/** Queue a notification for a fee-earner. Idempotent when a dedupKey is given: a second
 *  ping on the same matter+kind won't add a row while the first is still pending. */
export async function queueNotification(input: NotifyInput): Promise<void> {
  try {
    await query(
      `insert into notification (tenant_id, user_id, matter_id, matter_ref, kind, headline, did, action, dedup_key)
       select $1,$2,$3,$4,$5,$6,$7,$8,$9
        where not exists (
          select 1 from notification
           where tenant_id = $1 and kind = $5 and dedup_key = $9 and status = 'PENDING' and $9 is not null
        )`,
      [input.tenantId, input.userId, input.matterId ?? null, input.matterRef ?? null, input.kind, input.headline, input.did ?? null, input.action ?? null, input.dedupKey ?? null]
    );
  } catch {
    /* notification table absent (pre-migration) / transient — never block the trigger */
  }
}

interface Row { id: string; matter_ref: string | null; kind: string; headline: string; did: string | null; action: string | null }

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const KIND_ICON: Record<string, string> = { STATUS_CHANGED: '📌', DOC_RECEIVED: '📎', EMAIL_TRIAGED: '✉️' };

/** The "I'm on top of it" briefing: grouped by matter, each item = what came up · what I did · your action. */
function composeDigest(rows: Row[]): { subject: string; html: string } {
  const n = rows.length;
  const subject = n === 1 ? `Your matters — ${rows[0].matter_ref ?? 'an update'} needs a look` : `Your matters — ${n} updates need a look`;

  const byMatter = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.matter_ref ?? '—';
    (byMatter.get(k) ?? byMatter.set(k, []).get(k)!).push(r);
  }

  let body = `<p style="font-size:15px">Here's what's come up across your matters. I've handled what I can — a few need you.</p>`;
  for (const [ref, items] of byMatter) {
    body += `<div style="margin:14px 0"><div style="font-weight:700;font-size:14px;color:#0f172a;border-bottom:1px solid #e5e7eb;padding-bottom:4px">${esc(ref)}</div>`;
    for (const it of items) {
      body += `<div style="margin:8px 0 8px 2px">`;
      body += `<div style="font-size:14px;color:#0f172a">${KIND_ICON[it.kind] ?? '•'} <strong>${esc(it.headline)}</strong></div>`;
      if (it.did) body += `<div style="font-size:13px;color:#059669;margin-top:2px">✓ ${esc(it.did)}</div>`;
      if (it.action) body += `<div style="font-size:13px;color:#b45309;margin-top:2px">→ ${esc(it.action)}</div>`;
      body += `</div>`;
    }
    body += `</div>`;
  }
  body += `<p style="font-size:13px;color:#64748b;margin-top:16px">Open CONVEYi in Outlook to action these. To turn these briefings off, use the toggle in CONVEYi settings.</p>`;
  return { subject, html: body };
}

/**
 * Send each due person's pending notifications as ONE briefing email to their own inbox.
 * Called by the notify cron and opportunistically on worklist load. Scope to a tenant when
 * driven by a user request; omit for the cron sweep.
 */
export async function sendDueDigests(tenantId?: string): Promise<{ users: number; sent: number }> {
  // Drop stale pending items so a disconnected mailbox doesn't accumulate forever
  // (the actionable work still lives on the in-app worklist + timeline).
  await query(
    `update notification set status = 'DISMISSED'
      where status = 'PENDING' and created_at < now() - interval '${STALE_HOURS} hours' ${tenantId ? 'and tenant_id = $1' : ''}`,
    tenantId ? [tenantId] : []
  ).catch(() => {});

  const due = await query<{ user_id: string }>(
    `select user_id
       from notification
      where status = 'PENDING' ${tenantId ? 'and tenant_id = $1' : ''}
      group by user_id
     having (now() - max(created_at)) >= interval '${QUIET_MIN} minutes'
         or (now() - min(created_at)) >= interval '${MAX_HOLD_MIN} minutes'`,
    tenantId ? [tenantId] : []
  ).catch(() => [] as { user_id: string }[]);

  let sent = 0;
  for (const { user_id } of due) {
    try {
      // notify_enabled is guarded — pre-migration it won't exist, treat as enabled.
      let enabled = true;
      let email: string | null = null;
      try {
        const u = await queryOne<{ email: string; notify_enabled: boolean }>(`select email, notify_enabled from app_user where id = $1`, [user_id]);
        enabled = u?.notify_enabled ?? true;
        email = u?.email ?? null;
      } catch {
        const u = await queryOne<{ email: string }>(`select email from app_user where id = $1`, [user_id]);
        email = u?.email ?? null;
      }

      const rows = await query<Row>(
        `select id, matter_ref, kind, headline, did, action from notification where user_id = $1 and status = 'PENDING' order by created_at asc`,
        [user_id]
      );
      if (!rows.length) continue;
      const ids = rows.map((r) => r.id);

      if (!enabled) {
        await query(`update notification set status = 'DISMISSED' where id = any($1)`, [ids]).catch(() => {});
        continue;
      }

      const { subject, html } = composeDigest(rows);
      const draft = await createDraftMessage(user_id, subject, html, email ? [email] : []);
      if (draft?.id) {
        await sendDraftMessage(user_id, draft.id);
        await query(`update notification set status = 'SENT', sent_at = now() where id = any($1)`, [ids]);
        sent++;
      }
    } catch {
      /* transient (e.g. Graph token) — leave PENDING; the next sweep retries, stale-drop bounds it */
    }
  }
  return { users: due.length, sent };
}
