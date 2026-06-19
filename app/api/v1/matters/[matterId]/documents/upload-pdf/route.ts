import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { uploadToMatterFolder } from '@/lib/server/graph';
import { upsertChunks } from '@/lib/server/ai';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Manual document upload into the matter's OneDrive folder (e.g. a portal download).
export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const body = z
      .object({ fileName: z.string().min(1), base64: z.string().min(1), docType: z.string().optional(), mimeType: z.string().optional() })
      .parse(await req.json());
    await assertMatterAccess(user, matterId);

    const matter = await queryOne<{ folder_path: string | null }>(
      `select folder_path from matter where id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    if (!matter?.folder_path) return fail(new Error('Matter folder not provisioned'));

    const buffer = Buffer.from(body.base64, 'base64');
    const uploaded = await uploadToMatterFolder(user.userId, matter.folder_path, body.fileName, buffer);

    const doc = await queryOne<{ id: string }>(
      `insert into document
        (tenant_id, matter_id, source_type, drive_id, graph_item_id, storage_path, web_url, file_name, mime_type, size_bytes, doc_type, created_by)
       values ($1,$2,'UPLOAD',$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [
        user.tenantId,
        matterId,
        uploaded.parentReference?.driveId ?? null,
        uploaded.id,
        `${matter.folder_path}/${body.fileName}`,
        uploaded.webUrl ?? null,
        body.fileName,
        body.mimeType ?? 'application/octet-stream',
        buffer.length,
        body.docType ?? 'UPLOAD',
        user.userId,
      ]
    );
    await upsertChunks({
      tenantId: user.tenantId,
      matterId,
      sourceKind: 'DOCUMENT',
      sourceId: doc!.id,
      text: `${body.fileName} ${body.docType ?? ''}`,
      metadata: { fileName: body.fileName, graphItemId: uploaded.id, source: 'UPLOAD' },
    }).catch(() => {});

    await writeAudit({
      tenantId: user.tenantId,
      matterId,
      actorUserId: user.userId,
      actionType: 'DOCUMENT_UPLOADED',
      actionStatus: 'SUCCESS',
      payload: { fileName: body.fileName },
    });
    return ok({ id: doc!.id, webUrl: uploaded.webUrl ?? null });
  } catch (error) {
    return fail(error);
  }
}
