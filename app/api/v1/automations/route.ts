/** GET /api/v1/automations — the firm's enabled MANUAL automations, for the taskpane run menu. */
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { listAutomations, ensureDefaultAutomations } from '@/lib/server/automations';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    await ensureDefaultAutomations(user.tenantId, user.userId);
    const automations = (await listAutomations(user.tenantId, 'MANUAL')).filter((a) => a.enabled);
    return ok({ automations });
  } catch (error) {
    return fail(error);
  }
}
