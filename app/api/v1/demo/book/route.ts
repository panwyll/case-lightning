import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, fail } from '@/lib/server/http';
import { bookDemo, DemoBookingError } from '@/lib/server/demo/bookings';
import { firstTouch, firstTouchTags } from '@/lib/server/first-touch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Book a demo (lib/server/demo/bookings.ts). Where the person first came from (the ad, the email, a search) goes
 * with it. A filled-in hidden field (`website`) is a bot: it is thanked and dropped.
 */
export async function POST(req: NextRequest) {
  try {
    const b = z.object({
      start: z.string().datetime(),
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().email().max(200),
      firm: z.string().trim().min(2).max(160),
      phone: z.string().trim().max(40).regex(/^[0-9 +()-]*$/, 'A phone number, digits only').optional().default(''),
      feeEarners: z.string().trim().max(40).optional().default(''),
      note: z.string().trim().max(2000).optional().default(''),
      website: z.string().optional().default(''),
      source: z.record(z.string(), z.string().max(200)).optional().default({}),
    }).parse(await req.json());
    if (b.website) return ok({ start: b.start, end: b.start });
    const source = { ...b.source, ...firstTouchTags(await firstTouch(req.cookies.get('cl_vid')?.value)) };
    return ok(await bookDemo({ ...b, source }));
  } catch (error) {
    if (error instanceof DemoBookingError) return ok({ error: error.message }, { status: error.status });
    return fail(error);
  }
}
