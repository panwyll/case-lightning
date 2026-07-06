import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The matter's email threads — metadata only (subject, participants, last activity),
 * straight from email_thread. Message bodies are never stored in Postgres; the
 * companion [threadId] route reads them live from Graph on demand, so the "data
 * stays in your tenant" story holds.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const threads = await query<{
      id: string;
      subject: string | null;
      participants: unknown;
      lastMessageAt: string | null;
      conversationId: string | null;
      chaseAwaitingSince: string | null;
    }>(
      `select id,
              subject,
              participants,
              last_message_at        as "lastMessageAt",
              graph_conversation_id  as "conversationId",
              chase_awaiting_since   as "chaseAwaitingSince"
         from email_thread
        where matter_id = $1 and tenant_id = $2
        order by coalesce(last_message_at, created_at) desc
        limit 100`,
      [matterId, user.tenantId]
    ).catch(() =>
      // chase columns (migration 033) may not be applied — retry without them.
      query<any>(
        `select id, subject, participants, last_message_at as "lastMessageAt",
                graph_conversation_id as "conversationId", null as "chaseAwaitingSince"
           from email_thread
          where matter_id = $1 and tenant_id = $2
          order by coalesce(last_message_at, created_at) desc
          limit 100`,
        [matterId, user.tenantId]
      )
    );
    return ok({ threads });
  } catch (error) {
    return fail(error);
  }
}
