import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { sendDemoReminders } from '@/lib/server/demo/bookings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Booked demos' reminders, the day before and an hour before (lib/server/demo/bookings.ts). Vercel Cron, every quarter hour; protected by CRON_SECRET like the other cron routes. */
export async function GET(req: NextRequest) {
  try {
    assertFeature('db');
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return fail(Object.assign(new Error('Unauthorized'), { status: 401 }));
    }
    return ok(await sendDemoReminders());
  } catch (error) {
    return fail(error);
  }
}
