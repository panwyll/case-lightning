/**
 * The firm's matters that the engine is not running.
 *
 * The caseload map used to list only matters enrolled in the engine. In a real firm that
 * is almost none of them on day one — so a conveyancer signed in and found an empty sheet
 * where their caseload should be. That is wrong: the caseload is the firm's matters, and
 * whether the engine is reasoning about one is a property OF the matter, not a filter on
 * whether it exists.
 *
 * So every open matter appears. An untracked one stands in the phase its pipeline stage
 * implies, drawn plainly, and says honestly that nothing is being worked out for it yet.
 * It is never given a health it has not earned: an untracked matter is not "moving
 * normally", it is unknown, and the firm-level counts leave it out.
 */
import { query } from '../db';
import type { QueueRow } from './store';
import type { Lifecycle } from './graph';

/** The firm's pipeline stage (matter.stage) → the caseload band it stands in. */
const STAGE_TO_LIFECYCLE: Record<string, Lifecycle> = {
  INSTRUCTION: 'instructed',
  CONTRACT_PACK: 'pre_exchange',
  SEARCHES_ENQUIRIES: 'pre_exchange',
  REVIEW_SIGNING: 'ready_to_exchange',
  EXCHANGE: 'ready_to_exchange',
  COMPLETION: 'exchanged',
  POST_COMPLETION: 'post_completion',
};

/**
 * A firm-customised stage we have never seen stands in the long middle — "in progress" —
 * rather than being guessed into a later phase than it has reached.
 */
export function lifecycleForStage(stage: string | null): Lifecycle {
  if (!stage) return 'instructed';
  return STAGE_TO_LIFECYCLE[stage.toUpperCase()] ?? 'pre_exchange';
}

export interface UntrackedRow extends QueueRow {
  tracked: false;
}

export async function untrackedCaseRows(tenantId: string, opts: { assignedTo?: string | null; exclude: Set<string>; limit?: number }): Promise<UntrackedRow[]> {
  const rows = await query<{ id: string; matter_ref: string | null; property_address: string | null; stage: string | null; assigned_to: string | null; created_at: Date; updated_at: Date | null; completion_target_date: string | null; exchange_target_date: string | null }>(
    `select m.id, m.matter_ref, m.property_address, m.stage, m.assigned_to, m.created_at, m.updated_at,
            m.completion_target_date::text, m.exchange_target_date::text
       from matter m
       left join matter_engine_state s on s.matter_id = m.id
      where m.tenant_id = $1
        and coalesce(m.status, 'OPEN') <> 'CLOSED'
        and (s.matter_id is null or s.state->>'enrolled' is distinct from 'true')
        and ($2::uuid is null or m.assigned_to = $2 or (m.assigned_to is null and m.created_by = $2))
      order by m.updated_at desc nulls last
      limit $3`,
    [tenantId, opts.assignedTo ?? null, opts.limit ?? 500]
  ).catch(() => []);

  const now = Date.now();
  return rows
    .filter((r) => !opts.exclude.has(r.id))
    .map((r) => ({
      tracked: false as const,
      transactionType: null,
      tenantId,
      matterId: r.id,
      matterRef: r.matter_ref,
      propertyAddress: r.property_address,
      stage: r.stage ?? 'INSTRUCTION',
      shadowMode: false,
      assignedTo: r.assigned_to,
      pendingCount: 0,
      reviewCount: 0,
      loggedCount: 0,
      oldestPendingAt: null,
      openIssues: 0,
      holdingIssues: 0,
      targetCompletionDate: r.completion_target_date,
      targetExchangeDate: r.exchange_target_date,
      manualHandling: false,
      updatedAt: (r.updated_at ?? r.created_at).toISOString(),
      lifecycle: lifecycleForStage(r.stage),
      health: {
        band: 'normal' as const,
        headline: 'Not tracked by CONVEYi yet',
        why: ['Nothing is being worked out for this matter. Open it and enrol it to have the engine follow it.'],
        suggested: 'Enrol it',
        reasonCount: 0,
        counts: { waiting: 0, chasesDue: 0, blockingIssues: 0, openIssues: 0, decisions: 0, deadlines: 0 },
        pace: { stage: 'instruction' as never, inStage: 0, expected: 0, overrun: 0 },
      },
      dayOfCase: Math.max(0, Math.floor((now - r.created_at.getTime()) / 86_400_000)),
    }));
}
