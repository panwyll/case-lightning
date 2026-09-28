import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { chainCandidates } from '@/lib/server/chain';
import { engine } from '@/lib/server/engine/adapters';
import { profileOf } from '@/lib/server/engine/transactions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The cases this one could be linked to as the client's chain: this firm's open, enrolled cases on the other side, not linked elsewhere, not exchanged. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const svc = engine();
    const here = await svc.getState(user.tenantId, matterId);
    const side = profileOf(here.transactionType ?? 'freehold_purchase').side;
    const want = side === 'buyer' ? 'seller' : side === 'seller' ? 'buyer' : null;
    if (!want) return ok({ candidates: [] });
    const candidates = await chainCandidates(user, want, matterId);
    return ok({ candidates, want: want === 'seller' ? 'sale' : 'purchase' });
  } catch (error) {
    return fail(error);
  }
}
