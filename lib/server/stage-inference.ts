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

const ORDER = ['INSTRUCTION', 'CONTRACT_PACK', 'SEARCHES_ENQUIRIES', 'REVIEW_SIGNING', 'EXCHANGE', 'COMPLETION', 'POST_COMPLETION'];

// Highest-signal email triggers per stage (purchase + sale tracks merged) — see the
// "Key state transitions" tables in docs/conveyancing-process-model.md.
const SIGNALS: Array<{ stage: string; re: RegExp; label: string; bigLeapOk?: boolean }> = [
  {
    stage: 'CONTRACT_PACK',
    re: /\b(contract (pack|bundle|papers)|draft contract (enclosed|attached|herewith)|ta6\b|ta10\b|ta7\b|protocol (forms|documents)|lpe1)/i,
    label: 'Contract pack in play',
  },
  {
    stage: 'SEARCHES_ENQUIRIES',
    re: /\b(searches? (ordered|submitted|applied for|results?|received|back))\b|\b(local (authority )?search|llc1|con29|drainage (and water )?search|environmental search)\b|\benquiries (raised|attached|enclosed|herewith)|additional enquiries/i,
    label: 'Searches / enquiries underway',
  },
  {
    stage: 'REVIEW_SIGNING',
    re: /\b(report on title|mortgage offer (received|issued|enclosed)|signed (contract|documents?) (enclosed|attached|returned)|deposit (received|now held)|ready to exchange)\b/i,
    label: 'Review & signing',
  },
  {
    stage: 'EXCHANGE',
    re: /\b(contracts? (have been |now |were )?exchanged|exchange (of contracts? )?(took place|has taken place|confirmed|completed)|we (have )?exchanged)\b/i,
    label: 'Exchange confirmed',
    bigLeapOk: true,
  },
  {
    stage: 'COMPLETION',
    re: /\b(completion (has )?(taken place|occurred)|completion monies (received|sent)|completed today|keys (have been |can be )?released|legal completion)\b/i,
    label: 'Completion confirmed',
    bigLeapOk: true,
  },
  {
    stage: 'POST_COMPLETION',
    re: /\b(sdlt (return|paid|submitted)|stamp duty (return|paid)|ltt return|ap1\b|os1\b|land registry application|registration (lodged|submitted|pending|completed)|ds1\b|discharge (of mortgage|received))\b/i,
    label: 'Post-completion formalities',
  },
];

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
