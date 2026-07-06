import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { sendDraftMessage } from '@/lib/server/graph';
import { dismissWorklistItem } from '@/lib/server/worklist';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Send a reviewed draft without leaving the web app. This is the interactive,
 * human-in-the-loop send: the user has just read the draft on screen and clicked
 * Send — distinct from the auto-SEND rule path with its kill-switches. The Graph
 * helper refuses non-drafts, so this can only ever fire a draft once.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    await assertEntitled(user.tenantId);
    const body = z
      .object({ messageId: z.string().min(5), itemId: z.string().uuid().optional() })
      .parse(await req.json());

    const sent = await sendDraftMessage(user.userId, body.messageId);
    if (body.itemId) await dismissWorklistItem(user.tenantId, body.itemId).catch(() => {});

    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'EMAIL_SENT',
      actionStatus: 'SUCCESS',
      payload: { source: 'WORKLIST_WEB', subject: sent.subject },
    });
    return ok({ sent: true, subject: sent.subject });
  } catch (error) {
    return fail(error);
  }
}
