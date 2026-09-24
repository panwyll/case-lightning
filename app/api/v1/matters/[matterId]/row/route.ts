import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { queryOne } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';
import { boardSelect, type BoardMatter } from '@/lib/server/board';
import { listAssignees } from '@/lib/server/tasks';

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
    let matter: BoardMatter | null;
    try {
      matter = await queryOne<BoardMatter>(`${boardSelect(true)} where m.tenant_id = $1 and m.id = $2`, [user.tenantId, matterId]);
    } catch {
      // matter_task not present on this install — the drawer still opens without badges.
      matter = await queryOne<BoardMatter>(`${boardSelect(false)} where m.tenant_id = $1 and m.id = $2`, [user.tenantId, matterId]);
    }
    if (!matter) return fail(Object.assign(new Error('Matter not found.'), { status: 404 }));
    const assignees = await listAssignees(user.tenantId).catch(() => [] as Awaited<ReturnType<typeof listAssignees>>);
    return ok({ matter, assignees });
  } catch (error) {
    return fail(error);
  }
}
