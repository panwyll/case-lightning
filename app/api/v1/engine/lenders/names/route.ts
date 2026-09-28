import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { listLenders } from '@/lib/server/engine/lender-directory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The firm's lenders and their requirements, for filling in a form (any user; editing stays with admins). */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    return ok({ lenders: await listLenders(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}
