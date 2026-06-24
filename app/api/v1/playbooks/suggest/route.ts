/**
 * POST /api/v1/playbooks/suggest  { messageId?, conversationId?, subject? }
 * Asks the model which of the firm's workflows best fits this email. Returns
 * { playbookId | null, reason } — null when nothing is a confident fit.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { listThreadMessages } from '@/lib/server/graph';
import { threadToText } from '@/lib/server/text';
import { suggestPlaybook } from '@/lib/server/ai';
import { listPlaybooks } from '@/lib/server/playbooks';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const body = z
      .object({ messageId: z.string().optional(), conversationId: z.string().optional(), subject: z.string().optional() })
      .parse(await req.json());

    const playbooks = (await listPlaybooks(user.tenantId)).filter((p) => p.enabled);
    if (!playbooks.length) return ok({ playbookId: null, reason: '' });

    const emailText = body.conversationId
      ? threadToText(await listThreadMessages(user.userId, body.conversationId)).slice(0, 8000)
      : body.subject ?? '';
    if (!emailText.trim()) return ok({ playbookId: null, reason: '' });

    const s = await suggestPlaybook({
      userId: user.userId,
      tenantId: user.tenantId,
      emailText,
      playbooks: playbooks.map((p) => ({ id: p.id, name: p.name, description: p.description })),
    });
    const match = playbooks.find((p) => p.id === s.playbookId);
    if (match && s.confidence >= 0.55) return ok({ playbookId: match.id, reason: s.reason });
    return ok({ playbookId: null, reason: '' });
  } catch (error) {
    return fail(error);
  }
}
