import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { query, runAsAutomation, runAsSystem } from '@/lib/server/db';
import { inTouchClient, inTouchSyncDeps } from '@/lib/server/integrations/intouch/adapters';
import { pickUpFiledEmails, pollFolders } from '@/lib/server/integrations/intouch/poll';
import { fileMailboxEmailToCase } from '@/lib/server/mail/file-to-case';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * InTouch between syncs (integrations/intouch/poll.ts). `?folders=1` (every 15 minutes): each live case's newest folder
 * page. Otherwise (every minute): emails a person filed in InTouch, for the cases an unfiled email might belong to.
 * Nothing for a firm without InTouch. Protected by CRON_SECRET.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('db');
    const secret = process.env.CRON_SECRET;
    const given = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? req.nextUrl.searchParams.get('secret');
    if (!secret || given !== secret) return fail(Object.assign(new Error('Unauthorized.'), { status: 401 }));
    const folders = req.nextUrl.searchParams.get('folders') === '1';
    const tenants = await runAsSystem(() => query<{ tenant_id: string }>(`select tenant_id from intouch_connection where status = 'CONNECTED'`)).catch(() => []);
    const results: Record<string, unknown> = {};
    for (const { tenant_id: tenantId } of tenants) {
      try {
        if (folders) {
          const deps = await inTouchSyncDeps(tenantId);
          results[tenantId] = await runAsAutomation(() => pollFolders(deps, tenantId, { budgetMs: 90_000 / Math.max(1, tenants.length) }));
        } else {
          const api = await inTouchClient(tenantId);
          results[tenantId] = await runAsSystem(() => pickUpFiledEmails(tenantId, api, (owner, q, matterId) => fileMailboxEmailToCase(owner, matterId, q.messageId, q.conversationId), { budgetMs: 40_000 / Math.max(1, tenants.length) }));
        }
      } catch (err) {
        results[tenantId] = { error: (err as Error).message };
      }
    }
    return ok({ results });
  } catch (error) {
    return fail(error);
  }
}
