import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assistOnMessage } from '@/lib/server/assist';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The taskpane assistant in one call: triage + what-we-know + a prepared reply.
 * Human-in-the-loop — writes nothing to the matter (runTriage records its own
 * audit row); the reply is returned for review, never sent.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();
    const body = z
      .object({
        messageId: z.string(),
        conversationId: z.string().optional(),
        matterId: z.string().uuid().optional(),
        tone: z.enum(['NEUTRAL', 'FIRM', 'CHASING']).optional(),
      })
      .parse(await req.json());

    return ok(await assistOnMessage(user, body));
  } catch (error) {
    return fail(error);
  }
}
