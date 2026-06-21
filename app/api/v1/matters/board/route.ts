import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { refreshMasterBoard } from '@/lib/server/matters-board';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Rebuild the firm-wide master matters workbook and return its OneDrive URL. */
export async function POST() {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    return ok(await refreshMasterBoard(user));
  } catch (error) {
    return fail(error);
  }
}
