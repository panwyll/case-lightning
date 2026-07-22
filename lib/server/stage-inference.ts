/**
 * Email-driven stage progression — the board maintains itself.
 *
 * The whole product thesis is that the team shouldn't feed a tracker: email is the
 * source of truth. When a message arrives on a thread the firm has LINKED to a matter
 * (hasTrustedLink — the only write-safe signal; subject/body text is attacker-
 * controllable so fuzzy/token matches never move a matter), we look for the
 * transition phrases from docs/conveyancing-process-model.md and advance the stage.
 *
 * Deliberately conservative:
 *  - FORWARD-ONLY: a stage is never moved backwards automatically.
 *  - Big leaps (>2 stages) are only allowed on the unambiguous milestones
 *    (exchange / completion confirmations) — a stray "SDLT" mention in an early
 *    email won't teleport a matter to post-completion.
 *  - Every automatic move writes a matter_timeline_event with the email subject,
 *    so the drawer's Activity tab shows exactly why a card moved. Trust = provenance.
 */
import { query, queryOne } from './db';
import { STAGE_ORDER as ORDER, STAGE_SIGNALS as SIGNALS } from './process-model';

/**
 * Inspect an email's text and advance the matter's stage if a transition signal
 * warrants it. Caller MUST have verified the trusted-link gate. Returns the new
 * stage when a move happened, else null. Never throws.
 */
export async function maybeAdvanceStage(
  tenantId: string,
  matterId: string,
  emailText: string,
  emailSubject: string | null
): Promise<string | null> {
  try {
    const text = emailText.slice(0, 6000);
    // Furthest-along signal wins (an exchange confirmation beats a searches mention).
    const hit = [...SIGNALS].reverse().find((s) => s.re.test(text));
    if (!hit) return null;

    const m = await queryOne<{ stage: string | null; status: string | null }>(
      `select stage, status from matter where id = $1 and tenant_id = $2`,
      [matterId, tenantId]
    );
    if (!m || m.status === 'CLOSED' || m.status === 'MERGED') return null;

    const cur = ORDER.indexOf(m.stage || 'INSTRUCTION');
    const next = ORDER.indexOf(hit.stage);
    if (next <= cur) return null; // forward-only
    if (next - cur > 2 && !hit.bigLeapOk) return null; // no teleporting on weak signals

    await query(
      `update matter set stage = $1, stage_entered_at = now(), updated_at = now()
        where id = $2 and tenant_id = $3`,
      [hit.stage, matterId, tenantId]
    );
    await query(
      `insert into matter_timeline_event (tenant_id, matter_id, event_at, event_type, title, details)
       values ($1, $2, now(), 'STAGE_ADVANCED', $3, $4)`,
      [
        tenantId,
        matterId,
        `Stage → ${hit.stage.toLowerCase().replace(/_/g, ' ')} (automatic)`,
        `${hit.label} — detected in email${emailSubject ? `: “${emailSubject.slice(0, 140)}”` : ''}. Drag the card back if this is wrong.`,
      ]
    ).catch(() => {});
    return hit.stage;
  } catch {
    return null;
  }
}
