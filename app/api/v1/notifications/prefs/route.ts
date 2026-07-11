import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Whether this fee-earner receives the batched "here's what came up" briefing emails. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    let enabled = true;
    try {
      const row = await queryOne<{ notify_enabled: boolean }>(`select notify_enabled from app_user where id = $1`, [user.userId]);
      enabled = row?.notify_enabled ?? true;
    } catch {
      /* column absent pre-migration → default on */
    }
    return ok({ enabled });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await req.json());
    await query(`update app_user set notify_enabled = $1 where id = $2`, [enabled, user.userId]);
    return ok({ enabled });
  } catch (error) {
    return fail(error);
  }
}
