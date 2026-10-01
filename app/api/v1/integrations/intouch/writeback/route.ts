import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { setInTouchConnectionMeta } from '@/lib/server/integrations/intouch/adapters';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Turn write-back to InTouch on or off: documents filed here, and case notes. Admin only, audited. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    if (user.role !== 'ADMIN') throw Object.assign(new Error('Only an admin changes what is written to InTouch.'), { status: 403 });
    const body = z.object({ documents: z.boolean().optional(), notes: z.boolean().optional() }).parse(await req.json());
    await setInTouchConnectionMeta(user.tenantId, { documentsWriteback: body.documents, notesWriteback: body.notes });
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'INTOUCH_WRITEBACK_TOGGLED', actionStatus: 'SUCCESS', payload: body }).catch(() => {});
    return ok(body);
  } catch (error) {
    return fail(error);
  }
}
