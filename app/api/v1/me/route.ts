import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    // Firm name + onboarding flag so both the taskpane and admin can prompt/finish setup.
    const t = await queryOne<{ name: string | null; onboarded_at: string | null }>(
      `select name, onboarded_at from tenant where id = $1`,
      [user.tenantId]
    ).catch(() => null);
    return ok({ ...user, tenantName: t?.name ?? null, onboarded: !!t?.onboarded_at });
  } catch (error) {
    return fail(error);
  }
}
