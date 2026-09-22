import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { runAsAutomation } from '@/lib/server/db';
import { syncInTouch } from '@/lib/server/integrations/intouch/sync';
import { inTouchConfigured, inTouchSyncDeps } from '@/lib/server/integrations/intouch/adapters';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Run a sync now. `?full=1` ignores the watermark and re-reads everything. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    if (user.role !== 'ADMIN') throw Object.assign(new Error('Only an admin runs a sync.'), { status: 403 });
    if (!inTouchConfigured()) throw Object.assign(new Error('InTouch is not configured.'), { status: 503 });
    const full = z.enum(['0', '1']).default('0').parse(req.nextUrl.searchParams.get('full') ?? '0') === '1';
    const summary = await runAsAutomation(() => syncInTouch(inTouchSyncDeps(user.tenantId), user.tenantId, { full }));
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'INTOUCH_SYNC', actionStatus: summary.errors.length ? 'FAILED' : 'SUCCESS', payload: { ...summary } }).catch(() => {});
    return ok({ summary });
  } catch (error) {
    return fail(error);
  }
}
