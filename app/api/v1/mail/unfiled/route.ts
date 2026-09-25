import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { unfiledInbox } from '@/lib/server/mail/unfiled';
import { matchMessage } from '@/lib/server/matching';
import { query } from '@/lib/server/db';
import { checkSender } from '@/lib/server/mail/sender-check';
import { caseCards, explainMatch } from '@/lib/server/mail/case-cards';
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
 * Matching here is DETERMINISTIC — case refs, participants, the property's street and
 * postcode, names — not AI. The sender is checked first (mail/sender-check.ts): a forged
 * or look-alike sender does not count as evidence, and the row says so. Scrolling a queue must not cost a model call or burn the firm's monthly cap, which
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

    // Who this firm deals with, for the sender checks: its own people and every case contact.
    const [contacts, people] = await Promise.all([
      query<{ email: string; name: string | null }>(`select distinct lower(email) as email, name from matter_contact where tenant_id = $1 and email not like '%@intouch.party'`, [user.tenantId]).catch(() => []),
      query<{ email: string; name: string | null }>(`select lower(email) as email, display_name as name from app_user where tenant_id = $1`, [user.tenantId]).catch(() => []),
    ]);
    const known = {
      contacts: [...contacts, ...people],
      domains: [...new Set([...contacts, ...people].map((c) => c.email.split('@')[1]).filter(Boolean))],
    };

    // Suggest a case for each. One thread can appear as several messages in a page; match
    // once per conversation so the work is proportional to threads, not to replies.
    const byConversation = new Map<string, Awaited<ReturnType<typeof matchMessage>>>();
    const rows: Array<{ m: Record<string, any>; sender: ReturnType<typeof checkSender>; candidates: Awaited<ReturnType<typeof matchMessage>> }> = [];
    for (const m of unfiled as Array<Record<string, any>>) {
      const fromAddress: string | null = m.from?.emailAddress?.address ?? null;
      // The sender is checked before it is allowed to count as evidence of anything.
      const sender = checkSender(
        {
          fromName: m.from?.emailAddress?.name ?? null,
          fromAddress,
          replyTo: (m.replyTo ?? []).map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address).filter(Boolean),
          headers: Array.isArray(m.internetMessageHeaders) ? m.internetMessageHeaders : null,
        },
        known
      );
      const conversationId = (m.conversationId as string) ?? m.id;
      if (!byConversation.has(conversationId)) {
        const candidates = await matchMessage(
          user.tenantId,
          {
            conversationId: m.conversationId,
            fromAddress: fromAddress ?? undefined,
            recipientAddresses: (m.toRecipients ?? []).map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address).filter(Boolean),
            subject: m.subject ?? '',
            // The whole body, not the preview: a reference or postcode is often below the fold.
            bodyText: String(m.body?.content ?? m.bodyPreview ?? '').slice(0, 20_000),
          },
          { distrustSender: sender.verdict === 'suspicious' }
        ).catch(() => []);
        byConversation.set(conversationId, candidates);
      }
      rows.push({ m, sender, candidates: (byConversation.get(conversationId) ?? []).slice(0, 3) });
    }

    // Each suggested case as a person recognises it, and the sender's role on it.
    const matterIds = rows.flatMap((r) => r.candidates.map((c) => c.matterId));
    const cards = await caseCards(user.tenantId, matterIds);
    const senders = [...new Set(rows.map((r) => r.m.from?.emailAddress?.address?.toLowerCase()).filter(Boolean))] as string[];
    const roles = matterIds.length && senders.length
      ? await query<{ matter_id: string; email: string; role: string }>(
          `select matter_id, lower(email) as email, role from matter_contact where tenant_id = $1 and matter_id = any($2::uuid[]) and lower(email) = any($3)`,
          [user.tenantId, [...new Set(matterIds)], senders]
        ).catch(() => [])
      : [];
    const roleOf = (matterId: string, email: string | null) => roles.find((r) => r.matter_id === matterId && r.email === email?.toLowerCase())?.role ?? null;

    // Equal scores: an open case before a closed one.
    for (const r of rows) r.candidates.sort((a, b) => b.score - a.score || Number(!!cards.get(a.matterId)?.closed) - Number(!!cards.get(b.matterId)?.closed));

    const items = rows.map(({ m, sender, candidates }) => {
      const fromName: string | null = m.from?.emailAddress?.name ?? null;
      const fromAddress: string | null = m.from?.emailAddress?.address ?? null;
      return {
        id: m.id,
        conversationId: m.conversationId ?? null,
        subject: m.subject ?? '(no subject)',
        from: { name: fromName, address: fromAddress },
        receivedDateTime: m.receivedDateTime ?? null,
        bodyPreview: m.bodyPreview ?? '',
        hasAttachments: !!m.hasAttachments,
        webLink: m.webLink ?? null,
        sender,
        // Ranked best first. `score` is the engine's own 0–1 score and `band` its verdict;
        // `case` is the case in recognisable terms and `matched` says why, in words.
        suggestions: candidates.map((c) => ({
          matterId: c.matterId,
          matterRef: c.matterRef,
          propertyAddress: c.propertyAddress,
          band: c.band,
          score: c.score,
          case: cards.get(c.matterId) ?? null,
          matched: explainMatch(c.signals, { fromName, fromAddress, senderRole: roleOf(c.matterId, fromAddress) }),
        })),
      };
    });

    return ok({ items, nextLink, filedInPage: filedBy.size, setAsideInPage: setAside.size });
  } catch (error) {
    return fail(error);
  }
}
