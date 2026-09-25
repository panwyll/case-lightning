import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { inTouchConnection, inTouchCredentials } from '@/lib/server/integrations/intouch/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the settings page shows: the firm's saved InTouch details (never the secrets), the
 * connection, and what it has brought in.
 */
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
    const creds = await inTouchCredentials(user.tenantId);
    return ok({
      configured: !!creds,
      canManage: user.role === 'ADMIN',
      credentials: creds
        ? { source: creds.source, apiBaseUrl: creds.apiBaseUrl, authBaseUrl: creds.authBaseUrl, clientId: creds.clientId, hasSecret: !!creds.clientSecret, hasApiKey: !!creds.apiKey, hasWebhookSecret: !!creds.webhookSecret }
        : null,
      connection,
      counts: { cases: Number(counts.cases), identityChecks: Number(counts.identity_checks), forms: Number(counts.forms), documents: Number(counts.documents) },
    });
  } catch (error) {
    return fail(error);
  }
}
