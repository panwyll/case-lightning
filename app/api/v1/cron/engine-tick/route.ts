import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { runAsAutomation } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The engine's timer sweep (spec 2.6): for every active matter, send the chases that
 * are due and raise the escalations that are due, in working days. Intended for a
 * Vercel Cron (vercel.json); protected by CRON_SECRET like the other cron routes.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('db');
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return fail(Object.assign(new Error('Unauthorized'), { status: 401 }));
    }
    const result = await runAsAutomation(() => engine().tickAll(null));
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
