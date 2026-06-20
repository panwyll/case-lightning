import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { listThreadMessages } from '@/lib/server/graph';
import { summarizeThread } from '@/lib/server/ai';
import { threadToText } from '@/lib/server/text';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ graphThreadId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();
    const { graphThreadId } = await params;
    const body = z.object({ matterId: z.string().uuid().optional(), conversationId: z.string().optional() }).parse(await req.json());

    // A matter is optional here — summarising is read-only over the thread. When
    // one is linked we use its saved facts as extra context and gate access.
    if (body.matterId) await assertMatterAccess(user, body.matterId);
    const conversationId = body.conversationId ?? graphThreadId;
    const text = threadToText(await listThreadMessages(user.userId, conversationId));

    const summaryRow = body.matterId
      ? await queryOne<{ facts: Record<string, unknown> }>(
          `select facts from matter_summary where matter_id = $1 and tenant_id = $2`,
          [body.matterId, user.tenantId]
        )
      : null;

    const summary = await summarizeThread({
      userId: user.userId,
      tenantId: user.tenantId,
      matterId: body.matterId ?? null,
      threadText: text,
      matterSummary: JSON.stringify(summaryRow?.facts ?? {}),
    });

    await writeAudit({
      tenantId: user.tenantId,
      matterId: body.matterId ?? null,
      actorUserId: user.userId,
      actionType: 'THREAD_SUMMARISED',
      actionStatus: 'SUCCESS',
      payload: { graphThreadId },
    });

    return ok(summary);
  } catch (error) {
    return fail(error);
  }
}
