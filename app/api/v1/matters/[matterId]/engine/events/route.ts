import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The immutable log itself (component #7: every transition, AI action and human decision, attributable). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const q = z.object({ afterSeq: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().positive().max(2000).default(500) }).parse(Object.fromEntries(req.nextUrl.searchParams));
    const events = await engine().listEvents(user.tenantId, matterId, q);
    return ok({ events });
  } catch (error) {
    return fail(error);
  }
}
