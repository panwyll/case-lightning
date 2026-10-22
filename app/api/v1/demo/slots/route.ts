import { ok, fail } from '@/lib/server/http';
import { availableSlots } from '@/lib/server/demo/bookings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The demo times still free (app/conveyi/demo), by day in UK time. */
export async function GET() {
  try {
    return ok({ days: await availableSlots() }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return fail(error);
  }
}
