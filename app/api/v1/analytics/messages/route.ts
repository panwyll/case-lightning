import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { messagingMetrics } from '@/lib/server/analytics/messaging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Analytics → Cases, Messages: how the firm's correspondence is landing, the whole firm, four weeks against the four before. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    return ok(await messagingMetrics(user.tenantId));
  } catch (e) {
    return fail(e);
  }
}
