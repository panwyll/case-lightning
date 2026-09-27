import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { boardRow } from '@/lib/server/engine/open-case';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One matter, in the shape the matter drawer opens with, plus the team for its owner
 * dropdown. This is what lets the caseload open a matter in the same full view the board
 * does — for any conveyancer, not only admins (the board's own list is admin-only).
 * The usual access check applies, so the ethical wall holds here as everywhere else.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    return ok(await boardRow(user.tenantId, matterId));
  } catch (error) {
    return fail(error);
  }
}
