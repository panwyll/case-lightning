import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { dismissWorklistItem } from '@/lib/server/worklist';
import { scheduleSend, MANUAL_SEND_DELAY_MIN } from '@/lib/server/scheduledSend';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Schedule a reviewed draft for sending on a short delay. The user has read the draft
 * on screen and clicked Send, so this is a manual send: a brief (~2 min) "undo" window
 * — distinct from the longer window on auto-sent workflow update emails. The worker
 * sends it when due. Pass `now: true` to send immediately (skip the grace window).
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    await assertEntitled(user.tenantId);
    const body = z
      .object({
        messageId: z.string().min(5),
        itemId: z.string().uuid().optional(),
        source: z.enum(['MANUAL', 'REPLY']).optional(),
        now: z.boolean().optional(),
      })
      .parse(await req.json());

    const { id, scheduledAt } = await scheduleSend({
      tenantId: user.tenantId,
      userId: user.userId,
      graphMessageId: body.messageId,
      source: body.source ?? 'MANUAL',
      delayMinutes: body.now ? 0 : MANUAL_SEND_DELAY_MIN,
    });
    // Drop the worklist item now — it's committed to send (the user can still cancel the
    // schedule, which leaves the draft in Outlook for manual handling).
    if (body.itemId) await dismissWorklistItem(user.tenantId, body.itemId).catch(() => {});

    return ok({ scheduled: true, scheduleId: id, scheduledAt, delayMinutes: body.now ? 0 : MANUAL_SEND_DELAY_MIN });
  } catch (error) {
    return fail(error);
  }
}
