import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { processMatterFile } from '@/lib/server/files';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ matterId: string }> };

/** Logs an existing OneDrive file to the tracker + drafts a gated notification. */
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const body = z
      .object({ itemId: z.string().min(1), fileName: z.string().min(1), mimeType: z.string().optional() })
      .parse(await req.json());
    await assertMatterAccess(user, matterId);
    const result = await processMatterFile(user, matterId, {
      itemId: body.itemId,
      fileName: body.fileName,
      mimeType: body.mimeType ?? null,
    });
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
