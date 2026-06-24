import { NextRequest, after } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { assistPhase1, assistPhase2, assistOnMessage, emptySlow } from '@/lib/server/assist';
import { readAssistCache, writeAssistCache, markAssistError } from '@/lib/server/assist-cache';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The taskpane assistant in one call: triage + what-we-know + a prepared reply.
 * Human-in-the-loop — writes nothing to the matter (runTriage records its own
 * audit row); the reply is returned for review, never sent.
 *
 * Fast by design:
 *  - If the webhook already precomputed this message → return the cached result
 *    instantly (`ready: true`).
 *  - On a cold open → return the fast half now (`ready: false`) and compute the
 *    slow half (summary + draft) in the background; the taskpane polls until
 *    `ready: true`.
 *  - An explicit matterId is a deliberate re-analysis → always compute fresh.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();
    await assertEntitled(user.tenantId);
    const body = z
      .object({
        messageId: z.string(),
        conversationId: z.string().optional(),
        matterId: z.string().uuid().optional(),
        tone: z.enum(['NEUTRAL', 'FIRM', 'CHASING']).optional(),
      })
      .parse(await req.json());

    // Explicit matter (or a specific tone) → bypass the cache and compute fresh.
    if (body.matterId || body.tone) {
      return ok({ ...(await assistOnMessage(user, body)), ready: true });
    }

    // Warm path: the webhook (or a prior cold open) already did the work.
    const cached = await readAssistCache(user.tenantId, body.messageId);
    if (cached?.status === 'READY') {
      return ok({ ...cached.result, ready: true });
    }
    if (cached?.status === 'PARTIAL') {
      // Slow half is already computing from the first open; keep polling.
      return ok({ ...cached.result, ready: false });
    }

    // Cold open: compute the fast half now, fill the slow half in the background.
    const { fast, ctx } = await assistPhase1(user, body);
    await writeAssistCache(user.tenantId, body.messageId, { ...fast, ...emptySlow() }, 'PARTIAL');
    after(async () => {
      try {
        const slow = await assistPhase2(user, ctx);
        await writeAssistCache(user.tenantId, body.messageId, { ...fast, ...slow }, 'READY');
      } catch (error) {
        await markAssistError(user.tenantId, body.messageId, (error as Error).message).catch(() => {});
      }
    });

    return ok({ ...fast, ...emptySlow(), ready: false });
  } catch (error) {
    return fail(error);
  }
}
