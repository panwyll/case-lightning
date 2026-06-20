import { assertFeature, config } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { createInboxSubscription, deleteSubscription } from '@/lib/server/graph';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Graph caps Outlook-message subscriptions at ~4230 minutes; renew before expiry.
const SUB_MINUTES = 4000;

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const row = await queryOne<{ id: string; expires_at: string }>(
      `select id, expires_at from graph_subscription where user_id = $1 order by created_at desc limit 1`,
      [user.userId]
    );
    return ok({ enabled: Boolean(row), subscriptionId: row?.id ?? null, expiresAt: row?.expires_at ?? null });
  } catch (error) {
    return fail(error);
  }
}

export async function POST() {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    if (config.appUrl.includes('localhost')) {
      return fail(
        new Error('Auto-triage needs a public HTTPS URL Graph can reach — deploy first, then enable it (localhost is unreachable).')
      );
    }

    const clientState = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SUB_MINUTES * 60_000).toISOString();
    let sub;
    try {
      sub = await createInboxSubscription(
        user.userId,
        `${config.appUrl}/api/v1/graph/notifications`,
        clientState,
        expiresAt
      );
    } catch (graphError) {
      throw humanizeSubscriptionError(graphError);
    }

    await query(
      `insert into graph_subscription (id, tenant_id, user_id, resource, client_state, expires_at)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (id) do update set expires_at = excluded.expires_at, client_state = excluded.client_state`,
      [sub.id, user.tenantId, user.userId, sub.resource, clientState, sub.expirationDateTime ?? expiresAt]
    );

    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'AUTO_TRIAGE_ENABLED',
      actionStatus: 'SUCCESS',
      payload: { subscriptionId: sub.id },
    });

    return ok({ enabled: true, subscriptionId: sub.id, expiresAt: sub.expirationDateTime ?? expiresAt });
  } catch (error) {
    return fail(error);
  }
}

/**
 * The Graph SDK surfaces subscription-create failures as opaque strings like
 * "Operation: Create; Exception: [Status Code: Unauthorized; Reason: ]". Map the
 * common ones to plain, actionable guidance the user can see in the task pane.
 */
function humanizeSubscriptionError(error: unknown): Error {
  const status = (error as { statusCode?: number })?.statusCode;
  const text = error instanceof Error ? error.message : String(error);
  if (status === 401 || /unauthorized/i.test(text)) {
    return new Error(
      "Outlook wouldn't let us watch your inbox — your sign-in needs refreshing. Sign out and reconnect your account, then turn auto-triage on again."
    );
  }
  if (status === 403 || /forbidden/i.test(text)) {
    return new Error(
      'Your Microsoft 365 account doesn’t allow inbox watching (your IT admin may need to approve it). Auto-triage can’t be turned on without it.'
    );
  }
  return new Error("Couldn't turn on auto-triage just now. Please try again in a moment.");
}

export async function DELETE() {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const subs = await query<{ id: string }>(`select id from graph_subscription where user_id = $1`, [user.userId]);
    for (const s of subs) {
      await deleteSubscription(user.userId, s.id).catch(() => {});
      await query(`delete from graph_subscription where id = $1`, [s.id]);
    }
    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'AUTO_TRIAGE_DISABLED',
      actionStatus: 'SUCCESS',
    });
    return ok({ enabled: false });
  } catch (error) {
    return fail(error);
  }
}
