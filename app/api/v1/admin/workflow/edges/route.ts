import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { saveEdge, deleteEdge } from '@/lib/server/workflow';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Add a dependency edge (from = prerequisite, to = dependent). Rejects cycles. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { from, to } = z.object({ from: z.string().uuid(), to: z.string().uuid() }).parse(await req.json());
    const res = await saveEdge(user, from, to);
    if (!res.ok) return fail(Object.assign(new Error(res.reason || 'Invalid edge'), { status: 400 }));
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

/** Remove a dependency edge. */
export async function DELETE(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const from = z.string().uuid().parse(req.nextUrl.searchParams.get('from'));
    const to = z.string().uuid().parse(req.nextUrl.searchParams.get('to'));
    await deleteEdge(user, from, to);
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
