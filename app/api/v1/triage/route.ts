import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { getMessage } from '@/lib/server/graph';
import { runTriage } from '@/lib/server/triage';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Classify + match the current message. Human-in-the-loop: writes nothing to the
// matter, only returns ranked candidates with confidence + rationale.
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();
    const { messageId } = z.object({ messageId: z.string(), conversationId: z.string().optional() }).parse(await req.json());
    const message = await getMessage(user.userId, messageId);
    const result = await runTriage(user, message);
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
