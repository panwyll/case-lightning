import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { dismissTask, listDismissed, restoreTask } from '@/lib/server/task-dismissal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Dismissed tasks (for one case with ?matterId=), newest first. */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const matterId = z.string().uuid().nullish().parse(req.nextUrl.searchParams.get('matterId'));
    if (matterId) await assertMatterAccess(user, matterId);
    return ok({ dismissed: await listDismissed(user.tenantId, matterId ?? null) });
  } catch (error) {
    return fail(error);
  }
}

/** Dismiss a task ({matterId, ref, title}) or restore one ({restore: id}). */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const body = z.union([
      z.object({ restore: z.string().uuid() }),
      z.object({ matterId: z.string().uuid(), ref: z.string().min(3).max(200), title: z.string().max(300).nullish() }),
    ]).parse(await req.json());
    if ('restore' in body) { await restoreTask(user, body.restore); return ok({ ok: true }); }
    await assertMatterAccess(user, body.matterId);
    return ok(await dismissTask(user, body.matterId, body.ref, body.title ?? null));
  } catch (error) {
    return fail(error);
  }
}
