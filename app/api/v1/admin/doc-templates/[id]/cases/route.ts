import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { casesForTemplate } from '@/lib/server/doc-generate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The open cases this template could be generated for, each saying whether it has reached the document's step. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    return ok(await casesForTemplate(user, id));
  } catch (error) {
    return fail(error);
  }
}
