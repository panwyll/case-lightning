import { NextRequest, after } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { detectChases, runChaseSweep, snoozeChase } from '@/lib/server/chase';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The "to chase" worklist for the taskpane home tab: matched, OPEN matters where the
 * firm sent the last message and no reply has come within the SLA. Read-only here;
 * opening the tab also opportunistically flags them natively in Outlook (premium),
 * out of band — the same on-open self-heal pattern used for triage subscriptions.
 */
export async function GET() {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    await assertEntitled(user.tenantId);
    const chases = await detectChases(user.tenantId);
    after(async () => {
      await runChaseSweep(user.userId, user.tenantId).catch(() => {});
    });
    return ok({ chases });
  } catch (error) {
    return fail(error);
  }
}

/** Snooze a chase (e.g. "I've chased by phone") so it drops off the list until later. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    await assertEntitled(user.tenantId);
    const body = z
      .object({ threadId: z.string().uuid(), days: z.number().int().min(1).max(60).default(7) })
      .parse(await req.json());
    const until = new Date(Date.now() + body.days * 86_400_000);
    await snoozeChase(user.tenantId, body.threadId, until);
    return ok({ snoozedUntil: until.toISOString() });
  } catch (error) {
    return fail(error);
  }
}
