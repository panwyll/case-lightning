import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { updateTask } from '@/lib/server/tasks';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Update a task (status / assignee / due / detail) — mirrors to Tracker.xlsx. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ matterId: string; taskId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId, taskId } = await params;
    await assertMatterAccess(user, matterId);
    const body = z
      .object({
        type: z.string().optional(),
        detail: z.string().optional(),
        assignee: z.string().nullable().optional(),
        assigneeUserId: z.string().uuid().nullable().optional(),
        due: z.string().nullable().optional(),
        status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'NOTED']).optional(),
      })
      .parse(await req.json());
    const task = await updateTask(user, matterId, taskId, body);
    if (!task) return fail(new Error('Task not found.'));
    return ok({ task });
  } catch (error) {
    return fail(error);
  }
}
