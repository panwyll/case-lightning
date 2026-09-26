import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { mailboxesFor } from '@/lib/server/access';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The mailboxes this person may file from: their own, plus any granted on the Team tab. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    return ok({ mailboxes: await mailboxesFor(user) });
  } catch (error) {
    return fail(error);
  }
}
