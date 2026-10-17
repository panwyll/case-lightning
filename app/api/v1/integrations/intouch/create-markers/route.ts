import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query, runAsSystem } from '@/lib/server/db';
import { writeAudit } from '@/lib/server/audit';
import { CREATE_FIELDS, markersReady } from '@/lib/server/integrations/intouch/case-system';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const marker = z.string().trim().max(120).optional();

/** Which of the firm's InTouch data markers takes each field of a new case. Creating is on once the required ones are set. Admin only, audited. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    if (user.role !== 'ADMIN') throw Object.assign(new Error('Only an admin sets how cases are created in InTouch.'), { status: 403 });
    const body = z.object({
      ...Object.fromEntries(CREATE_FIELDS.map((f) => [f.key, marker])),
      template: z.object({ marker: z.string().trim().max(120), value: z.string().trim().max(200) }).nullish(),
    }).parse(await req.json());
    const clean = Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([, v]) => (typeof v === "string" ? v.trim() !== "" : !!v)));
    await runAsSystem(() => query(`update intouch_connection set create_markers = $2::jsonb, updated_at = now() where tenant_id = $1`, [user.tenantId, JSON.stringify(clean)]));
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'INTOUCH_CREATE_MARKERS_SET', actionStatus: 'SUCCESS', payload: clean }).catch(() => {});
    return ok({ markers: clean, on: markersReady(clean) });
  } catch (error) {
    return fail(error);
  }
}
