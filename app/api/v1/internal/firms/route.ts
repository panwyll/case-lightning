import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { config } from '@/lib/server/config';
import { listFirms, setComp } from '@/lib/server/firms-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The owner's dashboard: gated by INTERNAL_DASHBOARD_KEY (Bearer), like /internal/metrics; no Microsoft sign-in. */
function authorized(req: NextRequest): boolean {
  const key = config.internalDashboardKey;
  const got = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  return !!key && got.length > 0 && got === key;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try { return NextResponse.json({ firms: await listFirms() }); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
}

export async function PATCH(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = z.object({ tenantId: z.string().uuid(), comp: z.boolean(), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }).parse(await req.json());
    await setComp(body.tenantId, body.comp, body.until ?? null);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 400;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
