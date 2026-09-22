import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { inTouchConfigured, inTouchConnection } from '@/lib/server/integrations/intouch/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What the settings page shows: is it configured, connected, and what has it brought in. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const connection = await inTouchConnection(user.tenantId);
    const [counts] = await query<{ cases: string; identity_checks: string; forms: string; documents: string }>(
      `select
         (select count(*) from matter where tenant_id = $1 and intouch_case_id is not null)::text as cases,
         (select count(*) from intouch_applied where tenant_id = $1 and kind = 'identity_check')::text as identity_checks,
         (select count(*) from intouch_applied where tenant_id = $1 and kind = 'form')::text as forms,
         (select count(*) from intouch_applied where tenant_id = $1 and kind = 'document')::text as documents`,
      [user.tenantId]
    ).catch(() => [{ cases: '0', identity_checks: '0', forms: '0', documents: '0' }]);
    return ok({
      configured: inTouchConfigured(),
      connection,
      counts: { cases: Number(counts.cases), identityChecks: Number(counts.identity_checks), forms: Number(counts.forms), documents: Number(counts.documents) },
    });
  } catch (error) {
    return fail(error);
  }
}
