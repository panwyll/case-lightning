import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { assertEntitled } from '@/lib/server/plan';
import { ok, fail } from '@/lib/server/http';
import { generateForCase, previewForCase } from '@/lib/server/doc-generate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Generate this template for one case (only once the case has reached the document's step); the result is filed on the case. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    await assertEntitled(user.tenantId);
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    const { matterId, preview, again } = z.object({ matterId: z.string().uuid(), preview: z.boolean().optional(), again: z.boolean().optional() }).parse(await req.json());
    await assertMatterAccess(user, matterId);
    // A preview files and sends nothing.
    if (preview) return ok(await previewForCase(user, id, matterId));
    return ok(await generateForCase(user, id, matterId, { again: !!again }));
  } catch (error) {
    return fail(error);
  }
}
