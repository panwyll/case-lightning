import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { epaReport } from '@/lib/server/epa/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Analytics → Time (docs/epa.md §3): the whole firm's figures, never one person's. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    return ok({ report: await epaReport(user.tenantId, 8) });
  } catch (e) {
    return fail(e);
  }
}
