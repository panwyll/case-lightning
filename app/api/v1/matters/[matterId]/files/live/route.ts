import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { listMatterFiles } from '@/lib/server/graph';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Live listing of the matter's OneDrive folder (source of truth for documents).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);

    const matter = await queryOne<{ folder_path: string | null }>(
      `select folder_path from matter where id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    if (!matter?.folder_path) return ok({ files: [] });

    const files = (await listMatterFiles(user.userId, matter.folder_path)).map((f: any) => ({
      id: f.id,
      name: f.name,
      webUrl: f.webUrl ?? null,
      size: f.size ?? null,
      lastModified: f.lastModifiedDateTime ?? null,
    }));
    return ok({ files });
  } catch (error) {
    return fail(error);
  }
}
