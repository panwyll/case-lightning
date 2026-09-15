import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { writeAudit } from '@/lib/server/audit';
import { fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { auditCsv, auditMatter } from '@/lib/server/engine/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Component #7: the matter's audit pack. Verifies the hash chain and the replay
 * (log → state equals the read model), then exports every event with actor, source
 * document, confidence and hashes as JSON (default) or CSV (?format=csv). The export
 * itself is written to audit_log so access to the history is itself attributable.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const format = req.nextUrl.searchParams.get('format') === 'csv' ? 'csv' : 'json';
    const store = engine().eventStore;
    const report = await auditMatter(store, user.tenantId, matterId, await store.cachedState(user.tenantId, matterId));
    await writeAudit({ tenantId: user.tenantId, matterId, actorUserId: user.userId, actionType: 'ENGINE_AUDIT_EXPORT', actionStatus: 'SUCCESS', payload: { format, events: report.summary.events, chainOk: report.chain.ok, replayOk: report.replay.ok } }).catch(() => {});
    if (format === 'csv') {
      return new NextResponse(auditCsv(report), { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="engine-audit-${matterId}.csv"` } });
    }
    return NextResponse.json(report);
  } catch (error) {
    return fail(error);
  }
}
