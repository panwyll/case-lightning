/**
 * POST /api/v1/automations/suggest  { messageId?, conversationId?, subject? }
 * Asks the model which of the firm's MANUAL automations best fits this email.
 * Returns { automationId | null, reason } — null when nothing is a confident fit.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { listThreadMessages } from '@/lib/server/graph';
import { threadToText } from '@/lib/server/text';
import { suggestPlaybook } from '@/lib/server/ai';
import { listAutomations } from '@/lib/server/automations';
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

    const automations = (await listAutomations(user.tenantId, 'MANUAL')).filter((a) => a.enabled);
    if (!automations.length) return ok({ automationId: null, reason: '' });

    const emailText = body.conversationId
      ? threadToText(await listThreadMessages(user.userId, body.conversationId)).slice(0, 8000)
      : body.subject ?? '';
    if (!emailText.trim()) return ok({ automationId: null, reason: '' });

    const s = await suggestPlaybook({
      userId: user.userId,
      tenantId: user.tenantId,
      emailText,
      playbooks: automations.map((a) => ({ id: a.id, name: a.name, description: a.description })),
    });
    const match = automations.find((a) => a.id === s.playbookId);
    if (match && s.confidence >= 0.55) return ok({ automationId: match.id, reason: s.reason });
    return ok({ automationId: null, reason: '' });
  } catch (error) {
    return fail(error);
  }
}
