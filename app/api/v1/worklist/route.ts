import { NextRequest, after } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { getWorklist, dismissWorklistItem, snoozeWorklistItem } from '@/lib/server/worklist';
import { runChaseSweep, snoozeChase } from '@/lib/server/chase';
import { hasTeamAccess } from '@/lib/server/plan';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The canonical taskpane worklist: "ready to send" drafts + chases, in one list, no email
 * context required. Opening it also opportunistically re-runs the chase sweep out of band
 * (which refreshes chase state AND clears any drafts that have since been sent).
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    await assertEntitled(user.tenantId);
    // Who's worklist? An ADMIN can filter by any person via ?assignedTo=<userId>, or
    // ?assignedTo= (empty) / "any" for the whole firm — regardless of plan, so trials can
    // use it too. A non-admin fee earner only ever sees their own matters.
    const team = await hasTeamAccess(user.tenantId).catch(() => false);
    const isAdmin = user.role === 'ADMIN';
    const param = req.nextUrl.searchParams.get('assignedTo') ?? '';
    const assignedTo = isAdmin ? (!param || param === 'any' ? null : param) : user.userId;
    const items = await getWorklist(user.tenantId, assignedTo);
    after(async () => {
      await runChaseSweep(user.userId, user.tenantId).catch(() => {});
    });
    return ok({ items, team, isAdmin, assignedTo: assignedTo ?? '' });
  } catch (error) {
    return fail(error);
  }
}

/** Snooze or dismiss a worklist entry — a chase (by thread id) or a ready-to-send draft (by item id). */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    await assertEntitled(user.tenantId);
    const body = z
      .object({
        kind: z.enum(['CHASE', 'DRAFT_READY']),
        id: z.string(), // email_thread id (CHASE) or worklist_item id (DRAFT_READY)
        action: z.enum(['snooze', 'dismiss']).default('snooze'),
        days: z.number().int().min(1).max(60).default(7),
      })
      .parse(await req.json());
    const until = new Date(Date.now() + body.days * 86_400_000);
    if (body.kind === 'CHASE') {
      // A chase is derived, so there's no "done" — dismiss just snoozes it far out.
      const far = new Date(Date.now() + 3650 * 86_400_000);
      await snoozeChase(user.tenantId, body.id, body.action === 'dismiss' ? far : until);
    } else if (body.action === 'dismiss') {
      await dismissWorklistItem(user.tenantId, body.id);
    } else {
      await snoozeWorklistItem(user.tenantId, body.id, until);
    }
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
