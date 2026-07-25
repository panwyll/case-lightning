import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { query } from '@/lib/server/db';
import { listInboxMessages } from '@/lib/server/graph';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The web portal's inbox: one page of the user's mail, each row carrying whatever
 * triage/match the webhook already computed.
 *
 * READ-ONLY BY DESIGN. This never runs assist/triage and never meters the firm's
 * email quota — it only *reads* assist_cache. Scrolling a list must not cost AI
 * calls or burn the monthly cap; computation happens when a message is opened
 * (POST /assist), exactly as in the add-in.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    await assertEntitled(user.tenantId);

    const q = z
      .object({
        nextLink: z.string().optional().nullable(),
        search: z.string().max(200).optional().nullable(),
        top: z.coerce.number().int().min(5).max(100).optional(),
      })
      .parse({
        nextLink: req.nextUrl.searchParams.get('nextLink'),
        search: req.nextUrl.searchParams.get('search'),
        top: req.nextUrl.searchParams.get('top') ?? undefined,
      });

    const { messages, nextLink } = await listInboxMessages(user.userId, {
      top: q.top,
      nextLink: q.nextLink,
      search: q.search,
    });

    // One batched read of the precomputed assists for this page.
    const ids = messages.map((m: any) => m.id).filter(Boolean);
    const cached = ids.length
      ? await query<{ graph_message_id: string; status: string; result: any }>(
          `select graph_message_id, status, result from assist_cache
            where tenant_id = $1 and graph_message_id = any($2::text[])`,
          [user.tenantId, ids]
        ).catch(() => [])
      : [];
    const byId = new Map(cached.map((c) => [c.graph_message_id, c]));

    const items = messages.map((m: any) => {
      const c = byId.get(m.id);
      const r = c?.result ?? null;
      return {
        id: m.id,
        subject: m.subject ?? '(no subject)',
        from: { name: m.from?.emailAddress?.name ?? null, address: m.from?.emailAddress?.address ?? null },
        receivedDateTime: m.receivedDateTime ?? null,
        bodyPreview: m.bodyPreview ?? '',
        conversationId: m.conversationId ?? null,
        hasAttachments: !!m.hasAttachments,
        isRead: !!m.isRead,
        categories: m.categories ?? [],
        webLink: m.webLink ?? null,
        // Null when the webhook hasn't seen this message — the row still renders,
        // it just has no badge until the user opens it.
        assist: r
          ? {
              status: c!.status,
              matchBand: r.matchBand ?? null,
              matter: r.matter ?? null,
              intent: r.classification?.intent ?? null,
              urgency: r.classification?.urgency ?? null,
              needsAttention: !!r.classification?.needsAttention,
              ask: r.ask ?? null,
            }
          : null,
      };
    });

    return ok({ items, nextLink });
  } catch (error) {
    return fail(error);
  }
}
