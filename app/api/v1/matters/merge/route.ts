/**
 * POST /api/v1/matters/merge   { keepId, mergeId }
 * Merge the mergeId matter into keepId. Caller must have access to both (same
 * tenant). Used by the Admin "Actions" tab and the taskpane "merge into…" entry.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { mergeMatters } from '@/lib/server/merge';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { keepId, mergeId } = z
      .object({ keepId: z.string().uuid(), mergeId: z.string().uuid() })
      .parse(await req.json());
    await assertMatterAccess(user, keepId);
    await assertMatterAccess(user, mergeId);
    const result = await mergeMatters(user, keepId, mergeId);
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
