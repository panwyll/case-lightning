import { assertFeature, missingFor } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { engine } from '@/lib/server/engine/adapters';
import { unfiledInbox } from '@/lib/server/mail/unfiled';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The two numbers on the sidebar: decisions that need this person, and email not yet on
 * a case. Each fails soft to zero — a badge is never worth an error.
 */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const [tasks, email] = await Promise.all([
      engine().eventStore.listPendingDecisions(user.tenantId, { limit: 500 })
        .then((rows) => rows.filter((d) => d.kind !== 'auto_clear' && (!d.assignedTo || d.assignedTo === user.userId)).length)
        .catch(() => 0),
      missingFor('graph').length === 0 ? unfiledInbox(user, { top: 50 }).then((r) => r.unfiled.length).catch(() => 0) : Promise.resolve(0),
    ]);
    return ok({ tasks, email });
  } catch (error) {
    return fail(error);
  }
}
