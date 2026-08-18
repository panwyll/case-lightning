import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { getMessage } from '@/lib/server/graph';
import { getStaleDraftForThread, draftBodyHash } from '@/lib/server/worklist';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Verdict on this thread's ready draft: is it stale, and if so did the user edit it
 * since we wrote it? The pane calls this when it opens a thread.
 *
 *   { stale: false }              — nothing to do
 *   { stale: true, edited: true } — case moved AND the user changed the draft: warn,
 *                                   never auto-rewrite (their words must survive)
 *   { stale: true, edited: false }— case moved, draft untouched: safe to regenerate,
 *                                   which the pane does via the normal draft path
 *
 * Conservative by construction: we can only fetch the draft with the OWNER's token
 * (this is a delegated /me call), and we treat anything we can't confidently confirm
 * as unchanged as "edited" — flagging is harmless, silently overwriting an edit is not.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ graphThreadId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const { graphThreadId } = await params;

    const draft = await getStaleDraftForThread(user.tenantId, graphThreadId);
    if (!draft) return ok({ stale: false });

    // No id/hash to verify against → treat as edited (leave the flag, don't rewrite).
    if (!draft.graphMessageId || !draft.bodyHash) return ok({ stale: true, edited: true });

    let live: any;
    try {
      live = await getMessage(user.userId, draft.graphMessageId);
    } catch {
      // Not our mailbox (a colleague owns it) or the draft is gone — can't verify or
      // safely refresh, so leave it flagged for a human.
      return ok({ stale: true, edited: true, unverifiable: true });
    }

    const liveHash = draftBodyHash(live?.body?.content ?? '');
    return ok({ stale: true, edited: liveHash !== draft.bodyHash });
  } catch (error) {
    return fail(error);
  }
}
