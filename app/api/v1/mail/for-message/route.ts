import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { getMessage } from '@/lib/server/graph';
import { queueItemFor } from '@/lib/server/mail/filing-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Outlook's pane: the open email as the Email page shows it — filed already (where), or its suggested cases. Your own mailbox only. */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const messageId = req.nextUrl.searchParams.get('messageId') ?? '';
    if (!messageId || messageId.length > 400) throw Object.assign(new Error('Open an email first.'), { status: 400 });
    return ok(await queueItemFor(user, messageId, () => getMessage(user.userId, messageId)));
  } catch (e) {
    return fail(e);
  }
}
