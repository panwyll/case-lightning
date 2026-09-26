import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { askFile, findFacts } from '@/lib/server/engine/file-index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ask the file: `q` finds the facts and the passages (document, page) that answer it; `key` lists the register by key prefix. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const q = z.object({ q: z.string().max(400).optional(), key: z.string().max(120).optional() }).parse({ q: req.nextUrl.searchParams.get('q') ?? undefined, key: req.nextUrl.searchParams.get('key') ?? undefined });
    if (q.key && !q.q) return ok({ facts: await findFacts(user.tenantId, matterId, { key: q.key, limit: 100 }), passages: [] });
    if (!q.q?.trim()) return ok({ facts: [], passages: [] });
    return ok(await askFile(user.tenantId, matterId, q.q.trim()));
  } catch (error) {
    return fail(error);
  }
}
