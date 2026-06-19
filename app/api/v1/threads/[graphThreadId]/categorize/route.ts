import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { setMessageCategory } from '@/lib/server/graph';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ graphThreadId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const { graphThreadId } = await params;
    const body = z
      .object({ matterId: z.string().uuid(), messageId: z.string(), category: z.string().min(1) })
      .parse(await req.json());

    await assertMatterAccess(user, body.matterId);
    await setMessageCategory(user.userId, body.messageId, body.category);

    await writeAudit({
      tenantId: user.tenantId,
      matterId: body.matterId,
      actorUserId: user.userId,
      actionType: 'OUTLOOK_CATEGORY_UPDATED',
      actionStatus: 'SUCCESS',
      payload: { messageId: body.messageId, category: body.category, graphThreadId },
    });

    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
