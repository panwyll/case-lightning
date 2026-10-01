import { NextRequest, after } from 'next/server';
import { cookies } from 'next/headers';
import { ok, fail } from '@/lib/server/http';
import { emitMatterEvent } from '@/lib/server/events';
import { runAsSystem } from '@/lib/server/db';
import type { DocumentClassification } from '@/lib/server/engine/ports';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES, openPortal, portalAccess, portalCookieName, storePortalUpload } from '@/lib/server/client-portal';
import { devPortalUploads, isDevPortal } from '@/lib/server/dev-portal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** What the client said the file is (the task they uploaded it against), when that tells the engine where it goes. */
const ROLES = new Set<DocumentClassification['role']>(['property_forms', 'mortgage_offer', 'survey']);

/**
 * A file from the client's portal (multipart: `file`, and `role` when uploaded against a task).
 * It becomes a document on the case and goes through the engine like any file that arrives: read,
 * filed against the step it answers, or put in front of the conveyancer. The conveyancer is told.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw Object.assign(new Error('Choose a file to upload.'), { status: 400 });
    const mimeType = file.type || 'application/octet-stream';
    if (!UPLOAD_TYPES.has(mimeType)) throw Object.assign(new Error('Please upload a PDF, a photo or a Word document.'), { status: 415 });
    if (file.size > MAX_UPLOAD_BYTES) throw Object.assign(new Error('That file is too large to upload here (4 MB). Email it to us instead.'), { status: 413 });
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!bytes.length) throw Object.assign(new Error('That file is empty.'), { status: 400 });
    const roleIn = String(form.get('role') ?? '');
    const role = ROLES.has(roleIn as DocumentClassification['role']) ? (roleIn as DocumentClassification['role']) : null;

    if (isDevPortal(token)) {
      if ((await cookies()).get('cp_dev')?.value !== '1') throw Object.assign(new Error('Enter the code first.'), { status: 401 });
      const d = { id: `dev-up-${Date.now()}`, name: file.name, at: new Date().toISOString(), from: 'you' as const };
      devPortalUploads().unshift(d);
      return ok({ id: d.id, fileName: d.name });
    }
    const row = await openPortal(token);
    if (!row) throw Object.assign(new Error('This link no longer works. Reply to our latest email or call us.'), { status: 410 });
    if (!portalAccess(row.id, (await cookies()).get(portalCookieName(row.id))?.value)) throw Object.assign(new Error('Enter the code first.'), { status: 401 });
    const doc = await storePortalUpload(row, { fileName: file.name, mimeType, bytes });

    after(async () => {
      try {
        const { ingestFiledDocument } = await import('@/lib/server/engine/ingest-hook');
        const known: DocumentClassification | null = role ? { role, searchType: null, enquiryReferences: [], titleNumber: null, lender: null, confidence: 0.9, reason: 'the client uploaded it against this task on their portal' } : null;
        await ingestFiledDocument(row.tenant_id, row.matter_id, doc.id, known);
      } catch (err) {
        console.error('[portal] ingest after upload failed', err);
      }
      await runAsSystem(() => emitMatterEvent({
        tenantId: row.tenant_id,
        matterId: row.matter_id,
        eventType: 'CLIENT_PORTAL_UPLOAD',
        title: `The client uploaded ${doc.fileName} on their portal`,
        details: role ? `Uploaded against: ${role.replace(/_/g, ' ')}` : null,
        notify: { kind: 'DOC_RECEIVED', headline: `The client uploaded ${doc.fileName}`, did: 'Filed it on the case and read it', action: 'Check it is what was needed', dedupKey: `portal-upload:${doc.id}` },
      })).catch(() => {});
    });
    return ok(doc);
  } catch (error) {
    return fail(error);
  }
}
