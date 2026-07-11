import { query, queryOne } from './db';
import { queueNotification, type NotifyKind } from './notify';

/**
 * Record that something happened on a matter, and (optionally) nudge the fee-earner about it.
 *
 * This is the spine of the proactive loop: a single call both writes the matter timeline
 * (history) AND, when `notify` is given, queues a briefing line for the matter's assignee —
 * "here's what came up · what I did · what you need to do". Best-effort throughout: an event
 * emit must never break the thing that triggered it (a stage change, a doc save, triage).
 */
interface NotifyBeats {
  kind: NotifyKind;
  headline: string;
  did?: string | null;
  action?: string | null;
  dedupKey?: string | null;
}

/** Nudge the fee-earner assigned to a matter (no timeline write). Use when the caller has
 *  already recorded the timeline event (e.g. a stage change), or when a history row would
 *  just be noise (every inbound email). Skips silently if the matter is unassigned. */
export async function notifyMatter(tenantId: string, matterId: string, notify: NotifyBeats): Promise<void> {
  try {
    const asg = await queryOne<{ assigned_to: string | null; matter_ref: string | null }>(
      `select assigned_to, matter_ref from matter where id = $1 and tenant_id = $2`,
      [matterId, tenantId]
    );
    if (!asg?.assigned_to) return; // nobody to tell
    await queueNotification({
      tenantId,
      userId: asg.assigned_to,
      matterId,
      matterRef: asg.matter_ref,
      ...notify,
    });
  } catch {
    /* best-effort — never block the triggering action */
  }
}

export async function emitMatterEvent(input: {
  tenantId: string;
  matterId: string;
  eventType: string; // matter_timeline_event.event_type
  title: string;
  details?: string | null;
  notify?: NotifyBeats;
}): Promise<void> {
  // 1. Timeline (history) — same convention as the manual PATCH route.
  await query(
    `insert into matter_timeline_event (tenant_id, matter_id, event_at, event_type, title, details)
     values ($1,$2, now(), $3, $4, $5)`,
    [input.tenantId, input.matterId, input.eventType, input.title, input.details ?? null]
  ).catch(() => {
    /* timeline table absent / transient — non-critical */
  });

  // 2. Notify the fee-earner assigned to this matter (skip if unassigned).
  if (input.notify) await notifyMatter(input.tenantId, input.matterId, input.notify);
}
