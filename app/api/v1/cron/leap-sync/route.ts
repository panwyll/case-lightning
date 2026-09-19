import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { runAsAutomation } from '@/lib/server/db';
import { connectedTenants, leapBackendActive, leapSyncDeps, syncMatters } from '@/lib/server/integrations/leap/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Polling sync for every connected firm (the safety net under webhooks). Protected by CRON_SECRET like the engine tick. */
export async function GET(req: NextRequest) {
  try {
    assertFeature('db');
    const secret = process.env.CRON_SECRET;
    const given = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? req.nextUrl.searchParams.get('secret');
    if (!secret || given !== secret) return fail(Object.assign(new Error('Unauthorized.'), { status: 401 }));
    if (!leapBackendActive()) return ok({ skipped: 'LEAP not configured' });
    const results: Record<string, unknown> = {};
    for (const tenantId of await connectedTenants()) {
      try {
        results[tenantId] = await runAsAutomation(async () => syncMatters(await leapSyncDeps(tenantId), tenantId));
      } catch (err) {
        results[tenantId] = { error: (err as Error).message };
      }
    }
    return ok({ results });
  } catch (error) {
    return fail(error);
  }
}
