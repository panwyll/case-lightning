import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { estimatesOf, saveEstimates } from '@/lib/server/workload/scan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Your own estimate of the minutes spent finding what to say, per kind of email (blank clears one). */
export async function PUT(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const b = z.object({ estimates: z.record(z.string(), z.number().min(0).max(240).nullable()) }).parse(await req.json());
    await saveEstimates(user, b.estimates);
    return ok({ estimates: await estimatesOf(user.userId) });
  } catch (error) {
    return fail(error);
  }
}
