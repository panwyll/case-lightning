import { downloadDriveItem } from '@/lib/server/graph';
import { driveUserFor } from '@/lib/server/matter-drive';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { queryOne } from '@/lib/server/db';
import { fail } from '@/lib/server/http';
import { leapDocumentBytes } from '@/lib/server/integrations/leap/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serve a document's bytes when we hold them ourselves (document_blob — engine uploads
 * and provider downloads that did not go to OneDrive). Inline, so the decision viewer
 * can embed a PDF next to the summary. Same tenant + matter access checks as everything
 * else; the ethical wall applies through the document row.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(await params);
    const doc = await queryOne<{ matter_id: string; file_name: string | null; mime_type: string | null; bytes: Buffer | null; graph_item_id: string | null; web_url: string | null; content: string | null }>(
      `select d.matter_id, d.file_name, d.mime_type, b.bytes, d.graph_item_id, d.web_url, d.extracted_facts->>'content' as content from document d left join document_blob b on b.document_id = d.id where d.id = $1 and d.tenant_id = $2`,
      [documentId, user.tenantId]
    );
    if (!doc) return fail(Object.assign(new Error('Document not found.'), { status: 404 }));
    await assertMatterAccess(user, doc.matter_id);
    let bytes: Buffer | null = doc.bytes;
    let mime = doc.mime_type;
    if (!bytes) {
      // LEAP as the backend: mirrored documents keep their bytes in LEAP; fetch on demand.
      const fromLeap = await leapDocumentBytes(user.tenantId, documentId).catch(() => null);
      if (fromLeap) {
        bytes = fromLeap.bytes;
        mime = fromLeap.mimeType ?? mime;
      }
    }
    if (!bytes && doc.content) { bytes = Buffer.from(doc.content, 'utf8'); mime = mime ?? 'text/plain; charset=utf-8'; }
    if (!bytes && doc.graph_item_id) {
      // In the case's OneDrive folder: fetched as the drive's owner, the same account that filed it.
      const owner = await driveUserFor(user.tenantId, doc.matter_id, user.userId).catch(() => user.userId);
      bytes = await downloadDriveItem(owner, doc.graph_item_id).catch(() => null);
      if (!bytes && owner !== user.userId) bytes = await downloadDriveItem(user.userId, doc.graph_item_id).catch(() => null);
      if (!bytes && doc.web_url) return NextResponse.redirect(doc.web_url);
    }
    if (!bytes) return new NextResponse('This file could not be fetched from OneDrive. It may have been moved or deleted there; file it again from the email or the case folder.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-type': mime ?? 'application/octet-stream', 'content-disposition': `inline; filename="${(doc.file_name ?? 'document').replace(/"/g, '')}"`, 'cache-control': 'private, max-age=60' },
    });
  } catch (error) {
    return fail(error);
  }
}
