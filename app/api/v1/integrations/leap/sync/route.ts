import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { runAsAutomation } from '@/lib/server/db';
import { leapBackendActive, leapSyncDeps, syncMatters } from '@/lib/server/integrations/leap/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Run a sync now (admins): incremental from the watermark, or `full=1` for everything. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('db');
    if (!leapBackendActive()) return fail(Object.assign(new Error('LEAP is not configured.'), { status: 503 }));
    const user = await requireRole(['ADMIN']);
    const q = z.object({ full: z.enum(['0', '1']).default('0') }).parse(Object.fromEntries(req.nextUrl.searchParams));
    const summary = await runAsAutomation(() => syncMatters(leapSyncDeps(user.tenantId), user.tenantId, { full: q.full === '1' }));
    return ok({ summary });
  } catch (error) {
    return fail(error);
  }
}
