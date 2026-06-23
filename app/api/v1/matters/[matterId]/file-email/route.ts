import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { fileEmailInMatterFolder } from '@/lib/server/matter';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Moves a now-actioned email out of the inbox into its matter's Inbox subfolder.
// Called once the user has handled the email (replied / updated / delegated /
// marked handled) — the inbox is an in-tray, this clears the handled item.
export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const body = z.object({ messageId: z.string() }).parse(await req.json());
    await assertMatterAccess(user, matterId);

    const moved = await fileEmailInMatterFolder(user, matterId, body.messageId);

    await writeAudit({
      tenantId: user.tenantId,
      matterId,
      actorUserId: user.userId,
      actionType: 'EMAIL_FILED',
      actionStatus: 'SUCCESS',
      payload: { messageId: body.messageId, moved },
    });

    return ok({ moved });
  } catch (error) {
    return fail(error);
  }
}
