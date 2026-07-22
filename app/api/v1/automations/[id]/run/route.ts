/**
 * POST /api/v1/automations/:id/run  { messageId?, conversationId?, subject?, matterId? }
 * Run a MANUAL automation's steps against the open email/matter. Run-all-then-review:
 * nothing is sent. Returns a per-step result list.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { assertMatterAccess } from '@/lib/server/guard';
import { runAutomation } from '@/lib/server/automations';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    await assertEntitled(user.tenantId);
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    const body = z
      .object({
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

    const result = await runAutomation(
      user,
      id,
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
