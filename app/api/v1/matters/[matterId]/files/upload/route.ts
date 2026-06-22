import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { queryOne } from '@/lib/server/db';
import { uploadToMatterFolder } from '@/lib/server/graph';
import { processMatterFile } from '@/lib/server/files';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ matterId: string }> };

// ~14M base64 chars ≈ 10MB binary — a sane cap for a JSON-bodied upload.
const MAX_B64 = 14_000_000;

/**
 * Uploads a file into the matter's OneDrive folder, then logs it to the tracker
 * and drafts a gated notification (same pipeline as a file that arrived another
 * way). The upload is the natural "the file system changed" trigger.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const body = z
      .object({ fileName: z.string().min(1).max(255), contentBase64: z.string().min(1).max(MAX_B64), mimeType: z.string().optional() })
      .parse(await req.json());
    await assertMatterAccess(user, matterId);

    const matter = await queryOne<{ folder_path: string | null }>(
      `select folder_path from matter where id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    if (!matter?.folder_path) return fail(new Error('Matter folder not provisioned'));

    const buffer = Buffer.from(body.contentBase64, 'base64');
    const uploaded = await uploadToMatterFolder(user.userId, matter.folder_path, body.fileName, buffer);

    const result = await processMatterFile(user, matterId, {
      itemId: uploaded.id,
      fileName: body.fileName,
      mimeType: body.mimeType ?? null,
      bytes: buffer,
    });

    return ok({ file: { id: uploaded.id, name: body.fileName, webUrl: uploaded.webUrl ?? null }, ...result });
  } catch (error) {
    return fail(error);
  }
}
