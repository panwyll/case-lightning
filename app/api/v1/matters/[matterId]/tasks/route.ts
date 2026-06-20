import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { listTasks, createTask, listAssignees } from '@/lib/server/tasks';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A matter's task board — reconciles live Excel edits, then returns the tasks. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = await params;
    await assertMatterAccess(user, matterId);
    const [tasks, assignees] = await Promise.all([listTasks(user, matterId), listAssignees(user.tenantId)]);
    return ok({ tasks, assignees });
  } catch (error) {
    return fail(error);
  }
}

/** Create a task; it's written to Postgres and mirrored into Tracker.xlsx. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = await params;
    await assertMatterAccess(user, matterId);
    const body = z
      .object({
        type: z.string().optional(),
        detail: z.string().min(1),
        assignee: z.string().nullable().optional(),
        assigneeUserId: z.string().uuid().nullable().optional(),
        due: z.string().nullable().optional(),
        status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'NOTED']).optional(),
        source: z.string().optional(),
      })
      .parse(await req.json());
    return ok({ task: await createTask(user, matterId, body) });
  } catch (error) {
    return fail(error);
  }
}
