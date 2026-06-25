/** GET /api/v1/admin/import-analytics — response-time impact from the historical import. ADMIN. */
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { computeImportAnalytics } from '@/lib/server/import-analytics';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    return ok(await computeImportAnalytics(user.tenantId));
  } catch (error) {
    return fail(error);
  }
}
