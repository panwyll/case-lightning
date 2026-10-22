import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, fail } from '@/lib/server/http';
import { cancelDemo, DemoBookingError } from '@/lib/server/demo/bookings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cancel a demo from its link. A POST, so a mail scanner opening the link never cancels it. */
export async function POST(req: NextRequest) {
  try {
    const { token } = z.object({ token: z.string().max(80) }).parse(await req.json());
    return ok(await cancelDemo(token));
  } catch (error) {
    if (error instanceof DemoBookingError) return ok({ error: error.message }, { status: error.status });
    return fail(error);
  }
}
