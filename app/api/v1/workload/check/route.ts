import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { checkQueue, latestScan, recordCheck } from '@/lib/server/workload/scan';
import { OUT_CATEGORIES, type OutCategory } from '@/lib/server/workload/taxonomy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** The sample to check, each email read live from your Outlook (nothing is stored). Your own only. */
export async function GET() {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const scan = await latestScan(user.userId);
    if (!scan || (scan.status !== 'CHECKING' && scan.status !== 'COMPLETE')) return ok({ scanId: null, emails: [] });
    return ok({ scanId: scan.id, emails: await checkQueue(user, scan) });
  } catch (error) {
    return fail(error);
  }
}

/** Your answer for one email: the right category (the same one when you agree). */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const b = z.object({ scanId: z.string().uuid(), emailId: z.string().uuid(), category: z.enum(OUT_CATEGORIES as unknown as [OutCategory, ...OutCategory[]]) }).parse(await req.json());
    await recordCheck(user, b.scanId, b.emailId, b.category);
    return ok({ recorded: true });
  } catch (error) {
    return fail(error);
  }
}
