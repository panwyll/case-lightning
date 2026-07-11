import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { savePositions } from '@/lib/server/workflow';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Persist node positions after a drag on the canvas. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { positions } = z
      .object({ positions: z.array(z.object({ id: z.string().uuid(), x: z.number(), y: z.number() })).max(500) })
      .parse(await req.json());
    await savePositions(user, positions);
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
