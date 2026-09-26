import { query } from '../db';
import { unfiledInbox } from './unfiled';
import { matchMessage } from '../matching';
import { checkSender } from './sender-check';
import { knownParties } from './known-parties';
import { caseCards, explainMatch, senderOnCase } from './case-cards';
import { bulkReason, readablePreview } from './bulk';

/** How many of the newest inbox messages the filing queue reads. The page and the
 *  sidebar badge both use this, so the badge is the count of what the page shows. */
export const FILING_QUEUE_TOP = 25;

/**
 * The filing queue: email that is not on a case yet, each row with its best case
 * matches and whether it is probably not case mail at all. One function behind both the
 * Email page (/api/v1/mail/unfiled) and the sidebar count (/api/v1/nav/counts), so the
 * two can never disagree about what is in it. See the route for the rules.
 */
export async function filingQueue(
  user: { userId: string; tenantId: string },
  q: { top?: number; nextLink?: string | null; search?: string | null } = {}
) {
  const { unfiled, nextLink, filedBy, setAside } = await unfiledInbox(user, {
    top: q.top ?? FILING_QUEUE_TOP,
    nextLink: q.nextLink,
    search: q.search,
    withBody: true,
  });

  const known = await knownParties(user.tenantId);

  // Suggest a case for each. One thread can appear as several messages in a page; match
  // once per conversation so the work is proportional to threads, not to replies.
  const byConversation = new Map<string, Awaited<ReturnType<typeof matchMessage>>>();
  const rows: Array<{
    m: Record<string, any>;
    sender: ReturnType<typeof checkSender>;
    candidates: Awaited<ReturnType<typeof matchMessage>>;
  }> = [];
  for (const m of unfiled as Array<Record<string, any>>) {
    const fromAddress: string | null = m.from?.emailAddress?.address ?? null;
    // The sender is checked before it is allowed to count as evidence of anything.
    const sender = checkSender(
      {
        fromName: m.from?.emailAddress?.name ?? null,
        fromAddress,
        replyTo: (m.replyTo ?? [])
          .map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address)
          .filter(Boolean),
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
          recipientAddresses: (m.toRecipients ?? [])
            .map((r: { emailAddress?: { address?: string } }) => r.emailAddress?.address)
            .filter(Boolean),
          subject: m.subject ?? '',
          // The whole body, not the preview: a reference or postcode is often below the fold.
          bodyText: String(m.body?.content ?? m.bodyPreview ?? '').slice(0, 20_000),
        },
        { distrustSender: sender.verdict === 'suspicious' }
      ).catch(() => []);
      byConversation.set(conversationId, candidates);
    }
    rows.push({
      m,
      sender,
      candidates: (byConversation.get(conversationId) ?? []).slice(0, 3),
    });
  }

  // What the AI triage made of each email when it arrived (one model call per email,
  // already paid for): whether it is about a property transaction at all. Read, not re-run.
  const messageIds = rows.map((r) => r.m.id as string);
  const triaged = messageIds.length
    ? await query<{
        graph_message_id: string;
        case_mail: string | null;
        what: string | null;
      }>(
        `select distinct on (graph_message_id) graph_message_id, classification->>'caseMail' as case_mail, classification->>'caseMailWhat' as what
             from email_triage where tenant_id = $1 and graph_message_id = any($2) order by graph_message_id, created_at desc`,
        [user.tenantId, messageIds]
      ).catch(() => [])
    : [];
  const aiSaysNot = new Map(
    triaged
      .filter((t) => t.case_mail === 'no')
      .map((t) => [t.graph_message_id, t.what || 'not about a property transaction'])
  );

  // Each suggested case as a person recognises it, and the sender's role on it.
  const matterIds = rows.flatMap((r) => r.candidates.map((c) => c.matterId));
  const cards = await caseCards(user.tenantId, matterIds);
  const senders = [
    ...new Set(rows.map((r) => r.m.from?.emailAddress?.address?.toLowerCase()).filter(Boolean)),
  ] as string[];
  const roles =
    matterIds.length && senders.length
      ? await query<{ matter_id: string; email: string; role: string }>(
          `select matter_id, lower(email) as email, role from matter_contact where tenant_id = $1 and matter_id = any($2::uuid[]) and lower(email) = any($3)`,
          [user.tenantId, [...new Set(matterIds)], senders]
        ).catch(() => [])
      : [];
  const roleOf = (matterId: string, email: string | null) =>
    roles.find((r) => r.matter_id === matterId && r.email === email?.toLowerCase())?.role ?? null;

  // Equal scores: an open case before a closed one.
  for (const r of rows)
    r.candidates.sort(
      (a, b) => b.score - a.score || Number(!!cards.get(a.matterId)?.closed) - Number(!!cards.get(b.matterId)?.closed)
    );

  const items = rows.map(({ m, sender, candidates }) => {
    const fromName: string | null = m.from?.emailAddress?.name ?? null;
    const fromAddress: string | null = m.from?.emailAddress?.address ?? null;
    const headers = Array.isArray(m.internetMessageHeaders) ? m.internetMessageHeaders : null;
    // Newsletters and notifications with nothing tying them to a case are set apart, and
    // a sender check on them is noise: they are not pretending to be anyone on a case.
    // Either the mailing system says so, or the AI triage read it as unrelated — and in
    // both cases only when no case matches it at amber or better.
    const bulk = bulkReason({ headers, fromAddress }) ?? aiSaysNot.get(m.id) ?? null;
    const notCaseMail = !!bulk && !candidates.some((c) => c.band === 'AUTO' || c.band === 'STRONG');
    const { preview, forwardedFrom } = readablePreview(m.body?.content, m.bodyPreview ?? '');
    return {
      id: m.id,
      conversationId: m.conversationId ?? null,
      subject: m.subject ?? '(no subject)',
      from: { name: fromName, address: fromAddress },
      receivedDateTime: m.receivedDateTime ?? null,
      bodyPreview: preview,
      forwardedFrom: /^\s*(fw|fwd)\s*:/i.test(m.subject ?? '') ? forwardedFrom : null,
      notCaseMail: notCaseMail ? bulk : null,
      hasAttachments: !!m.hasAttachments,
      webLink: m.webLink ?? null,
      sender: notCaseMail
        ? {
            verdict: sender.verdict === 'suspicious' ? 'unverified' : sender.verdict,
            warnings: [],
          }
        : sender,
      // Ranked best first. `score` is the engine's own 0–1 score and `band` its verdict;
      // `case` is the case in recognisable terms and `matched` says why, in words.
      suggestions: candidates.map((c) => ({
        matterId: c.matterId,
        matterRef: c.matterRef,
        propertyAddress: c.propertyAddress,
        band: c.band,
        score: c.score,
        case: cards.get(c.matterId) ?? null,
        matched: explainMatch(c.signals, {
          fromName,
          fromAddress,
          senderRole: roleOf(c.matterId, fromAddress),
        }),
        senderOnCase: senderOnCase(c.signals, fromAddress),
      })),
    };
  });

  return {
    items,
    nextLink,
    filedInPage: filedBy.size,
    setAsideInPage: setAside.size,
  };
}

/** What the sidebar shows: rows on the first page of the queue that are case mail to file. */
export async function toFileCount(user: { userId: string; tenantId: string }): Promise<number> {
  const { items } = await filingQueue(user, { top: FILING_QUEUE_TOP });
  return items.filter((i) => !i.notCaseMail).length;
}
