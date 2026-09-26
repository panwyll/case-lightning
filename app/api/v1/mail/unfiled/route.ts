import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { filingQueue } from '@/lib/server/mail/filing-queue';
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
 * or look-alike sender does not count as evidence, and the row says so. Scrolling a queue
 * must not cost a model call or burn the firm's monthly cap, which is the same rule
 * /api/v1/mail follows. The queue is a table (email_queue, mail/queue.ts) fed by triage
 * and a mailbox sweep, so nothing is lost on a busy mailbox and the sidebar badge is a
 * count of the same rows.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    await assertEntitled(user.tenantId);

    const q = z
      .object({ cursor: z.string().max(200).nullish(), limit: z.coerce.number().int().min(5).max(200).optional() })
      .parse({ cursor: req.nextUrl.searchParams.get('cursor'), limit: req.nextUrl.searchParams.get('limit') ?? undefined });

    // The sweep (backlog once, then one page of the newest mail) runs on the first page
    // only; a "load more" is a plain table read.
    return ok(await filingQueue(user, { ...q, sweep: !q.cursor }));
  } catch (error) {
    return fail(error);
  }
}
