/** GET /api/v1/playbooks — the firm's enabled playbooks, for the taskpane run menu. */
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { listPlaybooks } from '@/lib/server/playbooks';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const playbooks = (await listPlaybooks(user.tenantId)).filter((p) => p.enabled);
    return ok({ playbooks });
  } catch (error) {
    return fail(error);
  }
}
