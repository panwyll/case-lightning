/**
 * POST /api/v1/playbooks/run-step
 *   { step: { type, config }, messageId?, conversationId?, subject?, matterId?, inputs? }
 * Runs ONE workflow step (a one-off action, e.g. Delegate or Notify) without a
 * saved playbook. Reuses the same step executor. Never sends.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { assertMatterAccess } from '@/lib/server/guard';
import { executeSteps } from '@/lib/server/playbooks';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    await assertEntitled(user.tenantId);
    const body = z
      .object({
        step: z.object({
          type: z.enum(['CREATE_MATTER', 'GENERATE_DOCS', 'CREATE_TASK', 'DRAFT_REPLY', 'ARCHIVE_MATTER', 'DELEGATE', 'NOTIFY']),
          config: z.record(z.any()).default({}),
        }),
        messageId: z.string().optional(),
        conversationId: z.string().optional(),
        subject: z.string().optional(),
        matterId: z.string().uuid().optional(),
        inputs: z
          .object({
            delegateToUserId: z.string().optional(),
            delegateToEmail: z.string().optional(),
            delegateToName: z.string().optional(),
            notifyEmail: z.string().optional(),
            notifyName: z.string().optional(),
          })
          .optional(),
      })
      .parse(await req.json());

    if (body.matterId) await assertMatterAccess(user, body.matterId);

    const result = await executeSteps(
      user,
      [body.step],
      {
        messageId: body.messageId ?? null,
        conversationId: body.conversationId ?? null,
        subject: body.subject ?? null,
        matterId: body.matterId ?? null,
      },
      body.inputs ?? {}
    );
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
