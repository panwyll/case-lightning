import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { unfiledInbox } from '@/lib/server/mail/unfiled';
import { matchMessage } from '@/lib/server/matching';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The filing queue: email that is not on a case yet (docs/email-filing.md).
 *
 * This is NOT an inbox. It answers one question per row — which case does this belong
 * to? — and a row leaves the list as soon as that is answered. So:
 *
 *   • threads already filed to a matter are gone (email_thread);
 *   • threads a person has said are not case email are gone (email_not_filed);
 *   • what is left carries the best matter matches we can find, so the common case is
 *     one click.
 *
 * Matching here is DETERMINISTIC — case refs, participants, addresses, postcodes — not
 * AI. Scrolling a queue must not cost a model call or burn the firm's monthly cap, which
 * is the same rule /api/v1/mail follows.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    await assertEntitled(user.tenantId);

    const q = z
      .object({ nextLink: z.string().nullish(), search: z.string().max(200).nullish(), top: z.coerce.number().int().min(5).max(100).optional() })
      .parse({ nextLink: req.nextUrl.searchParams.get('nextLink'), search: req.nextUrl.searchParams.get('search'), top: req.nextUrl.searchParams.get('top') ?? undefined });

    const { unfiled, nextLink, filedBy, setAside } = await unfiledInbox(user, { top: q.top ?? 25, nextLink: q.nextLink, search: q.search, withBody: true });

    // Suggest a case for each. One thread can appear as several messages in a page; match
    // once per conversation so the work is proportional to threads, not to replies.
    const byConversation = new Map<string, Awaited<ReturnType<typeof matchMessage>>>();
    const items = [];
    for (const m of unfiled as Array<Record<string, any>>) {
      const conversationId = (m.conversationId as string) ?? m.id;
      if (!byConversation.has(conversationId)) {
        const candidates = await matchMessage(user.tenantId, {
          conversationId: m.conversationId,
          fromAddress: m.from?.emailAddress?.address ?? undefined,
          recipientAddresses: (m.toRecipients ?? []).map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address).filter(Boolean),
          subject: m.subject ?? '',
          // The whole body, not the preview: a reference or postcode is often below the fold.
          bodyText: String(m.body?.content ?? m.bodyPreview ?? '').slice(0, 20_000),
        }).catch(() => []);
        byConversation.set(conversationId, candidates);
      }
      const candidates = byConversation.get(conversationId) ?? [];
      items.push({
        id: m.id,
        conversationId: m.conversationId ?? null,
        subject: m.subject ?? '(no subject)',
        from: { name: m.from?.emailAddress?.name ?? null, address: m.from?.emailAddress?.address ?? null },
        receivedDateTime: m.receivedDateTime ?? null,
        bodyPreview: m.bodyPreview ?? '',
        hasAttachments: !!m.hasAttachments,
        webLink: m.webLink ?? null,
        // Ranked best first; the top one is what the button offers. `score` is the engine's
        // own 0–1 score, shown as a percentage; `band` is its AUTO / STRONG / WEAK verdict.
        suggestions: candidates.slice(0, 3).map((c) => ({ matterId: c.matterId, matterRef: c.matterRef, propertyAddress: c.propertyAddress, band: c.band, score: c.score, why: c.signals.slice(0, 3).map((s) => s.detail) })),
      });
    }

    return ok({ items, nextLink, filedInPage: filedBy.size, setAsideInPage: setAside.size });
  } catch (error) {
    return fail(error);
  }
}
