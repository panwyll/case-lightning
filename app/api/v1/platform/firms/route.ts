import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { assertPlatformAdmin } from '@/lib/server/platform-admin';
import { listFirms, setComp } from '@/lib/server/firms-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Every firm, with where it stands on billing: for the people who run CONVEYi. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    assertPlatformAdmin(user);
    return ok({ firms: await listFirms() });
  } catch (error) {
    return fail(error);
  }
}

/** Comp a firm (free, full service), optionally until a date; or end a comp. */
export async function PATCH(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    assertPlatformAdmin(user);
    const body = z.object({ tenantId: z.string().uuid(), comp: z.boolean(), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }).parse(await req.json());
    await setComp(body.tenantId, body.comp, body.until ?? null);
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
