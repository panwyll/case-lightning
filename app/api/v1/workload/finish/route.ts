import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { finishScan } from '@/lib/server/workload/scan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Finish checking: the report is final (with however many were checked). */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const b = z.object({ scanId: z.string().uuid() }).parse(await req.json());
    await finishScan(user.userId, b.scanId);
    return ok({ finished: true });
  } catch (error) {
    return fail(error);
  }
}
