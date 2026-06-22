import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { query, queryOne } from '@/lib/server/db';
import { listMatterFiles } from '@/lib/server/graph';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ matterId: string }> };

/**
 * Lists the LIVE contents of the matter's OneDrive folder (not just files saved
 * through the app), so a fee earner can see whether e.g. the contract is there —
 * including files dropped in directly that never arrived by email. Flags which
 * have already been processed (recorded in `document`) so the UI can offer to
 * log + draft an update for the new ones.
 */
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);

    const matter = await queryOne<{ folder_path: string | null }>(
      `select folder_path from matter where id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    if (!matter?.folder_path) return ok({ files: [], folderProvisioned: false });

    const [items, processed] = await Promise.all([
      listMatterFiles(user.userId, matter.folder_path).catch(() => [] as any[]),
      query<{ graph_item_id: string | null; file_name: string }>(
        `select graph_item_id, file_name from document where matter_id = $1 and tenant_id = $2`,
        [matterId, user.tenantId]
      ),
    ]);
    const processedIds = new Set(processed.map((d) => d.graph_item_id).filter(Boolean));
    const processedNames = new Set(processed.map((d) => d.file_name));

    const files = items
      .filter((it: any) => !it.folder) // files only
      .map((it: any) => ({
        id: it.id as string,
        name: it.name as string,
        webUrl: (it.webUrl as string) ?? null,
        size: (it.size as number) ?? null,
        lastModified: (it.lastModifiedDateTime as string) ?? null,
        mimeType: (it.file?.mimeType as string) ?? null,
        processed: processedIds.has(it.id) || processedNames.has(it.name),
      }));

    return ok({ files, folderProvisioned: true });
  } catch (error) {
    return fail(error);
  }
}
