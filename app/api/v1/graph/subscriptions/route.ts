import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { deleteSubscription } from '@/lib/server/graph';
import {
  createSubscription,
  setAutoTriageDesired,
  isAutoTriageDesired,
  SubscriptionSetupError,
} from '@/lib/server/subscriptions';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const [row, desired] = await Promise.all([
      queryOne<{ id: string; expires_at: string }>(
        `select id, expires_at from graph_subscription where user_id = $1 order by created_at desc limit 1`,
        [user.userId]
      ),
      isAutoTriageDesired(user.userId),
    ]);
    return ok({ enabled: Boolean(row), desired, subscriptionId: row?.id ?? null, expiresAt: row?.expires_at ?? null });
  } catch (error) {
    return fail(error);
  }
}

export async function POST() {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();

    // Record the opt-in intent first, so self-heal will re-arm later even if this
    // particular create fails or the subscription is lost.
    await setAutoTriageDesired(user.userId, true);

    let created;
    try {
      created = await createSubscription(user.userId, user.tenantId);
    } catch (e) {
      if (e instanceof SubscriptionSetupError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }

    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'AUTO_TRIAGE_ENABLED',
      actionStatus: 'SUCCESS',
      payload: { subscriptionId: created.id },
    });

    return ok({ enabled: true, desired: true, subscriptionId: created.id, expiresAt: created.expiresAt });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE() {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();

    // Clear intent first so self-heal won't immediately re-arm what we're tearing down.
    await setAutoTriageDesired(user.userId, false);

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
    return ok({ enabled: false, desired: false });
  } catch (error) {
    return fail(error);
  }
}
