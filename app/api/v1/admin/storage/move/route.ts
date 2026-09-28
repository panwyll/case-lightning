import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { copyDriveFilesToStorage, moveBlobsToStorage, storageConfigured, storageCounts } from '@/lib/server/blob-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Where this firm's files are held. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    return ok(await storageCounts(user.tenantId));
  } catch (error) {
    return fail(error);
  }
}

/** Move this firm's files into Supabase Storage for up to 50 seconds: those still in the database, then those only in OneDrive. Run again until nothing is left. */
export async function POST() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    if (!storageConfigured()) return fail(Object.assign(new Error('Supabase Storage is not configured (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).'), { status: 503 }));
    const until = Date.now() + 50_000;
    let moved = 0;
    let copied = 0;
    let failed = 0;
    for (;;) {
      const r = await moveBlobsToStorage(25, user.tenantId);
      moved += r.moved;
      if (!r.moved || !r.left || Date.now() > until) break;
    }
    while (Date.now() < until) {
      const r = await copyDriveFilesToStorage(user.tenantId, 10);
      copied += r.copied;
      failed += r.failed;
      if (!r.copied || !r.left) break;
    }
    return ok({ moved, copied, failed, ...(await storageCounts(user.tenantId)) });
  } catch (error) {
    return fail(error);
  }
}
