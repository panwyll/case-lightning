import { assertFeature, missingFor } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { workItems, canCover } from '@/lib/server/engine/my-work';
import { assistantMay } from '@/lib/server/engine/http';
import { actionable } from '@/lib/server/engine/work';
import { toFileCount } from '@/lib/server/mail/filing-queue';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The two numbers on the sidebar: decisions that need this person, and email to file.
 * The email number is exactly the "to file" count on the Email page — same queue, same
 * page size, bulk mail set apart — so the badge and the page never disagree. Each fails
 * soft to zero — a badge is never worth an error.
 */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const [tasks, email] = await Promise.all([
      // The badge is the Tasks page's own number: everything a person has to pick up (decisions, issues, escalations) across the caseload the page opens on ("Anyone" for cover roles).
      workItems(user, { all: canCover(user) || user.role === 'ASSISTANT' }).then(({ items }) => actionable(items).filter((i) => user.role !== 'ASSISTANT' || assistantMay(i.kind)).length).catch(() => 0),
      missingFor('graph').length === 0
        ? toFileCount(user).catch((e) => {
            // Fail soft to zero, but say why in the log: a missing email_queue table (migration
            // 081 not applied) looks exactly like an empty queue from the sidebar.
            console.warn('[nav counts] email count failed:', (e as Error).message);
            return 0;
          })
        : Promise.resolve(0),
    ]);
    return ok({ tasks, email });
  } catch (error) {
    return fail(error);
  }
}
