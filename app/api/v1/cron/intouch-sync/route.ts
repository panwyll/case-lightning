import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { query, runAsAutomation, runAsSystem } from '@/lib/server/db';
import { syncInTouch } from '@/lib/server/integrations/intouch/sync';
import { inTouchClient, inTouchSyncDeps } from '@/lib/server/integrations/intouch/adapters';
import { readInTouchActivity } from '@/lib/server/epa/live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Polling sync for every connected firm — the safety net under the webhooks, because
 * per-resource webhook coverage is one of the things the gated reference has to confirm.
 * Protected by CRON_SECRET like the engine tick.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('db');
    const secret = process.env.CRON_SECRET;
    const given = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? req.nextUrl.searchParams.get('secret');
    if (!secret || given !== secret) return fail(Object.assign(new Error('Unauthorized.'), { status: 401 }));
    const tenants = await runAsSystem(() => query<{ tenant_id: string }>(`select tenant_id from intouch_connection where status = 'CONNECTED'`)).catch(() => []);
    const results: Record<string, unknown> = {};
    for (const { tenant_id: tenantId } of tenants) {
      try {
        const deps = await inTouchSyncDeps(tenantId);
        results[tenantId] = await runAsAutomation(() => syncInTouch(deps, tenantId));
      } catch (err) {
        // One firm's broken connection must never stop the others syncing.
        results[tenantId] = { error: (err as Error).message };
      }
      // What the firm filed since yesterday, for the Time page (epa/live.ts). Never fails the sync.
      try {
        results[`${tenantId}:activity`] = await readInTouchActivity(tenantId, await inTouchClient(tenantId));
      } catch (err) {
        results[`${tenantId}:activity`] = { error: (err as Error).message };
      }
    }
    return ok({ results });
  } catch (error) {
    return fail(error);
  }
}
