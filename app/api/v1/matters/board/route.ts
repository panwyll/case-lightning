import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { refreshMasterBoard, getBoardUrl } from '@/lib/server/matters-board';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The board's URL if it already exists — fast, no sync (so the button can open it instantly). */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    return ok({ webUrl: await getBoardUrl(user) });
  } catch (error) {
    return fail(error);
  }
}

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
