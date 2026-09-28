import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { moveBlobsToStorage, storageConfigured } from '@/lib/server/blob-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Move files still held in the database into Supabase Storage, in batches, for up to 50 seconds. */
export async function POST() {
  try {
    assertFeature('auth');
    await requireRole(['ADMIN']);
    if (!storageConfigured()) return fail(Object.assign(new Error('Supabase Storage is not configured (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).'), { status: 503 }));
    const until = Date.now() + 50_000;
    let moved = 0;
    let left = 0;
    do {
      const r = await moveBlobsToStorage(25);
      moved += r.moved;
      left = r.left;
      if (!r.moved) break;
    } while (left > 0 && Date.now() < until);
    return ok({ moved, left });
  } catch (error) {
    return fail(error);
  }
}
