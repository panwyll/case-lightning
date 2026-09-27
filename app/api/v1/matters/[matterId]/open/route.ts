import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { project } from '@/lib/server/engine/projection';
import { getMatterSummary } from '@/lib/server/matter';
import { engineView, graphModel, boardRow } from '@/lib/server/engine/open-case';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Everything the case view opens with, in one request: the engine view, the log, the case
 * model, the board row and the summary. One session check, one access check, one read of
 * the log, one projection — where five requests each did all of that.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const svc = engine();
    const events = await svc.listEvents(user.tenantId, matterId);
    const state = project(user.tenantId, matterId, events);
    const [view, row, detail] = await Promise.all([
      engineView(svc, user.tenantId, matterId, state),
      boardRow(user.tenantId, matterId),
      getMatterSummary(matterId, user.tenantId),
    ]);
    if (!detail) return fail(Object.assign(new Error('Case not found.'), { status: 404 }));
    return ok({ view, events, graph: graphModel(state, new Date()), row, detail });
  } catch (error) {
    return fail(error);
  }
}
