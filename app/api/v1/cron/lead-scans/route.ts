import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { sweepLeadScans } from '@/lib/server/lead-scan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Free inbox scans: wipe any sign-in token past the hour the page promises (lib/server/lead-scan.ts). Vercel Cron, every minute; protected by CRON_SECRET like the other cron routes. */
export async function GET(req: NextRequest) {
  try {
    assertFeature('db');
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return fail(Object.assign(new Error('Unauthorized'), { status: 401 }));
    }
    return ok(await sweepLeadScans());
  } catch (error) {
    return fail(error);
  }
}
