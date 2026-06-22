import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BODY = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().optional(),
  matterId: z.string().uuid().optional(),
  action: z.enum(['reply', 'action', 'delegate', 'ignore']),
});

/**
 * Records the move the fee earner actually chose for an email (reply / action /
 * delegate / ignore). Purely an analytics signal — it changes nothing — but it's
 * the only way to capture decisions that have no other backend footprint (notably
 * "ignore", and "delegate" before any task is created). Joined against the
 * EMAIL_TRIAGED label in v_email_journey so we can see label vs. what the user did.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const body = BODY.parse(await req.json());
    await writeAudit({
      tenantId: user.tenantId,
      matterId: body.matterId ?? null,
      actorUserId: user.userId,
      actionType: 'USER_ACTION_CHOSEN',
      actionStatus: 'SUCCESS',
      payload: { messageId: body.messageId, conversationId: body.conversationId ?? null, action: body.action },
    });
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
