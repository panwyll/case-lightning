import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { chainCandidates } from '@/lib/server/chain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** For a case being set up: the client's other half it could be linked to (?side=seller lists sales, ?side=buyer purchases). */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const side = z.enum(['buyer', 'seller']).parse(req.nextUrl.searchParams.get('side'));
    const q = req.nextUrl.searchParams;
    const list = (k: string) => q.getAll(k).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean).slice(0, 12);
    return ok({ candidates: await chainCandidates(user, side, null, { names: list('name'), emails: list('email') }) });
  } catch (error) {
    return fail(error);
  }
}
