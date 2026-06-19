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
    const body = z.object({ matterId: z.string().uuid(), conversationId: z.string().optional() }).parse(await req.json());

    await assertMatterAccess(user, body.matterId);
    const conversationId = body.conversationId ?? graphThreadId;
    const text = threadToText(await listThreadMessages(user.userId, conversationId));

    const summaryRow = await queryOne<{ facts: Record<string, unknown> }>(
      `select facts from matter_summary where matter_id = $1 and tenant_id = $2`,
      [body.matterId, user.tenantId]
    );

    const summary = await summarizeThread({
      userId: user.userId,
      threadText: text,
      matterSummary: JSON.stringify(summaryRow?.facts ?? {}),
    });

    await writeAudit({
      tenantId: user.tenantId,
      matterId: body.matterId,
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
