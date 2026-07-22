import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { getMessage } from '@/lib/server/graph';
import { runTriage } from '@/lib/server/triage';
import { runAutoAutomations } from '@/lib/server/automations';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Premium path: triage a message and apply auto-rules if the firm has opted in
 * and the match is AUTO-band. Intended to be driven by the taskpane or a future
 * Graph change-notification webhook. Returns both the triage result and the
 * actions taken (or why none were).
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();
    const { messageId } = z.object({ messageId: z.string(), conversationId: z.string().optional() }).parse(await req.json());
    const message = await getMessage(user.userId, messageId);
    const triage = await runTriage(user, message);
    const outcome = await runAutoAutomations(user, message, triage);
    return ok({ triage, outcome });
  } catch (error) {
    return fail(error);
  }
}
