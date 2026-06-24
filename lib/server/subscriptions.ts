/**
 * Auto-triage Graph subscriptions — create, renew and SELF-HEAL.
 *
 * A Graph inbox subscription lives ~66h and must be renewed before it expires,
 * or new mail stops triggering on-receipt triage. Renewal runs on a daily cron,
 * but a cron can be missed (Hobby plan is best-effort) or a renewal can fail
 * (the user's M365 token lapsed), after which firing silently dies.
 *
 * Auto-triage is always on (no opt-out — see isAutoTriageDesired), so the only
 * transient state is the `graph_subscription` row. `ensureSubscription` reconciles
 * it: if the subscription is missing or expiring soon, it renews or recreates it.
 * The taskpane calls this on open (so active users self-heal), and so does the cron.
 */
import { config } from './config';
import { query, queryOne } from './db';
import { createInboxSubscription, renewSubscription } from './graph';
import crypto from 'node:crypto';

// Graph caps Outlook-message subscriptions at ~4230 minutes; stay safely under.
const SUB_MINUTES = 4000;
// Renew/recreate when the subscription has less than this left.
const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000;

export interface SubscriptionStatus {
  /** A live subscription exists and isn't about to expire. */
  enabled: boolean;
  /** The user has opted in (intent), regardless of live-subscription state. */
  desired: boolean;
  expiresAt: string | null;
  /** Set when the user wants auto-triage but we couldn't (re)arm it — e.g. token lapsed. */
  needsReconnect?: boolean;
}

export class SubscriptionSetupError extends Error {}

/** Maps opaque Graph subscription-create failures to plain, actionable guidance. */
export function humanizeSubscriptionError(error: unknown): SubscriptionSetupError {
  const status = (error as { statusCode?: number })?.statusCode;
  const text = error instanceof Error ? error.message : String(error);
  if (status === 401 || /unauthorized/i.test(text)) {
    return new SubscriptionSetupError(
      "Outlook wouldn't let us watch your inbox — your sign-in needs refreshing. Sign out and reconnect your account, then turn auto-triage on again."
    );
  }
  if (status === 403 || /forbidden/i.test(text)) {
    return new SubscriptionSetupError(
      'Your Microsoft 365 account doesn’t allow inbox watching (your IT admin may need to approve it). Auto-triage can’t be turned on without it.'
    );
  }
  return new SubscriptionSetupError("Couldn't turn on auto-triage just now. Please try again in a moment.");
}

/** True once the user has opted in (intent flag). */
// Auto-triage is always on — it only matches/tags/pre-analyses incoming mail and
// never sends, so there's no opt-out. (A future premium auto-PROCESS feature, which
// would actually act on mail, will be a separate opt-in — wired another time.)
export async function isAutoTriageDesired(_userId: string): Promise<boolean> {
  return true;
}

/**
 * Creates a fresh Graph subscription for the user and records it. Throws a
 * SubscriptionSetupError (already humanised) on Graph failure. Requires a public
 * URL Graph can reach.
 */
export async function createSubscription(
  userId: string,
  tenantId: string
): Promise<{ id: string; expiresAt: string }> {
  if (config.appUrl.includes('localhost')) {
    throw new SubscriptionSetupError(
      'Auto-triage needs a public HTTPS URL Graph can reach — deploy first, then enable it (localhost is unreachable).'
    );
  }
  const clientState = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SUB_MINUTES * 60_000).toISOString();
  let sub;
  try {
    sub = await createInboxSubscription(userId, `${config.appUrl}/api/v1/graph/notifications`, clientState, expiresAt);
  } catch (graphError) {
    throw humanizeSubscriptionError(graphError);
  }
  const finalExpiry = sub.expirationDateTime ?? expiresAt;
  await query(
    `insert into graph_subscription (id, tenant_id, user_id, resource, client_state, expires_at)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (id) do update set expires_at = excluded.expires_at, client_state = excluded.client_state`,
    [sub.id, tenantId, userId, sub.resource, clientState, finalExpiry]
  );
  return { id: sub.id, expiresAt: finalExpiry };
}

/**
 * Reconciles intent with state. No-op (cheap, DB-only) when auto-triage is off or
 * the subscription is healthy. Otherwise renews an expiring subscription or
 * recreates a missing/dead one. Never throws — returns status, flagging
 * `needsReconnect` when the user wants it but we couldn't arm it (token lapsed).
 */
export async function ensureSubscription(userId: string, tenantId: string): Promise<SubscriptionStatus> {
  const desired = await isAutoTriageDesired(userId);
  if (!desired) return { enabled: false, desired: false, expiresAt: null };

  const existing = await queryOne<{ id: string; expires_at: string }>(
    `select id, expires_at from graph_subscription where user_id = $1 order by created_at desc limit 1`,
    [userId]
  );

  // Healthy — nothing to do.
  if (existing && new Date(existing.expires_at).getTime() - Date.now() > RENEW_WITHIN_MS) {
    return { enabled: true, desired: true, expiresAt: existing.expires_at };
  }

  // Expiring soon — try to renew in place first.
  if (existing) {
    const newExpiry = new Date(Date.now() + SUB_MINUTES * 60_000).toISOString();
    try {
      await renewSubscription(userId, existing.id, newExpiry);
      await query(`update graph_subscription set expires_at = $1 where id = $2`, [newExpiry, existing.id]);
      return { enabled: true, desired: true, expiresAt: newExpiry };
    } catch {
      // Subscription is dead on Graph's side — drop the stale row and recreate.
      await query(`delete from graph_subscription where id = $1`, [existing.id]).catch(() => {});
    }
  }

  // Missing or un-renewable — recreate. If THIS fails (e.g. token lapsed), keep the
  // intent flag set so a later open (after reconnecting) heals it.
  try {
    const created = await createSubscription(userId, tenantId);
    return { enabled: true, desired: true, expiresAt: created.expiresAt };
  } catch {
    return { enabled: false, desired: true, expiresAt: null, needsReconnect: true };
  }
}
