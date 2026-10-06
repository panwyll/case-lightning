import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { advanceScan, latestScan } from '@/lib/server/workload/scan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A slice reads and classifies pages within its own 12-second budget.
export const maxDuration = 60;

/** Advance your running scan by one slice. The page calls this until `done`. */
export async function POST() {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();
    const scan = await latestScan(user.userId);
    if (!scan) return ok({ done: true, status: 'IDLE' });
    const s = await advanceScan(user, scan);
    return ok({ done: !['SCANNING_SENT', 'SCANNING_INBOX'].includes(s.status), status: s.status, messagesRead: s.messages_read, classified: s.classified, error: s.error });
  } catch (error) {
    return fail(error);
  }
}
