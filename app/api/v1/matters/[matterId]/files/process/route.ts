import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { query, queryOne } from '@/lib/server/db';
import { downloadDriveItem, appendTrackerRow, createDraftMessage } from '@/lib/server/graph';
import { reviewDocument } from '@/lib/server/ai';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ matterId: string }> };

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

/**
 * Logs a file from the matter's OneDrive folder into the tracker, and — only when
 * the file is one we can actually read and confirm carries substantive content —
 * drafts a "we now hold X" notification email (draft-only, never sent).
 *
 * Rational gating: the tracker is ALWAYS updated (a real file landed), but the
 * notification is only drafted for files we can verify. PDFs are read by Claude;
 * formats we can't parse server-side (e.g. .docx) are logged and flagged for the
 * fee earner to decide — so an empty "contract.docx" never triggers a false
 * "we've got the contract" email.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const body = z
      .object({ itemId: z.string().min(1), fileName: z.string().min(1), mimeType: z.string().optional() })
      .parse(await req.json());
    await assertMatterAccess(user, matterId);

    const matter = await queryOne<{
      folder_path: string | null;
      tracker_item_id: string | null;
      matter_ref: string;
      property_address: string | null;
    }>(
      `select folder_path, tracker_item_id, matter_ref, property_address from matter where id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    if (!matter) return fail(new Error('Matter not found'));

    const buffer = await downloadDriveItem(user.userId, body.itemId);
    const isPdf = body.mimeType === 'application/pdf' || /\.pdf$/i.test(body.fileName);

    // Read + classify only what we can verify (PDF via Claude). Anything else is
    // logged but not auto-notified.
    let documentType = '';
    let substantive = false;
    let readable = false;
    if (isPdf) {
      try {
        const { review } = await reviewDocument({
          userId: user.userId,
          tenantId: user.tenantId,
          matterId,
          fileName: body.fileName,
          mimeType: 'application/pdf',
          pdfBase64: buffer.toString('base64'),
          expectations: 'Identify the document type and whether it carries substantive content (as opposed to an empty, blank, or placeholder file).',
          retrievedContext: '',
        });
        readable = true;
        documentType = (review.documentType || '').trim();
        const detail = (review.keyDetails?.length ?? 0) > 0 || (review.summary || '').trim().length > 40;
        substantive = !!documentType && detail;
      } catch {
        /* couldn't read it — fall through to log-only */
      }
    }

    // Record the file so it isn't reprocessed (idempotent on graph_item_id).
    const existing = await queryOne<{ id: string }>(
      `select id from document where matter_id = $1 and tenant_id = $2 and graph_item_id = $3`,
      [matterId, user.tenantId, body.itemId]
    );
    if (!existing) {
      await query(
        `insert into document (tenant_id, matter_id, source_type, graph_item_id, storage_path, file_name, mime_type, doc_type, created_by)
         values ($1,$2,'ONEDRIVE_UPLOAD',$3,$4,$5,$6,$7,$8)`,
        [
          user.tenantId,
          matterId,
          body.itemId,
          matter.folder_path ? `${matter.folder_path}/${body.fileName}` : body.fileName,
          body.fileName,
          body.mimeType ?? null,
          documentType || null,
          user.userId,
        ]
      );
    }

    // Always reflect the arrival in the Excel tracker.
    let trackerUpdated = false;
    if (matter.tracker_item_id) {
      await appendTrackerRow(user.userId, matter.tracker_item_id, {
        date: new Date().toISOString().slice(0, 10),
        type: documentType || 'Document',
        detail: `Received file: ${body.fileName}${substantive ? '' : readable ? ' (appears empty/uninformative)' : ''}`,
        owner: '',
        due: '',
        status: 'NOTED',
      }).catch(() => {});
      trackerUpdated = true;
    }

    // Gate the notification: only draft for files we read and confirmed substantive.
    let drafted = false;
    let draftSubject: string | null = null;
    if (substantive) {
      const where = matter.property_address ? ` (${matter.property_address})` : '';
      draftSubject = `${matter.matter_ref} — ${documentType} received`;
      const bodyHtml =
        `<p>Dear Sir or Madam,</p>` +
        `<p>We confirm that we now hold the following document on the above matter${escapeHtml(where)}: ` +
        `<strong>${escapeHtml(documentType)}</strong> (${escapeHtml(body.fileName)}).</p>` +
        `<p>We are updating our file accordingly and will revert with any further requirements.</p>` +
        `<p>Kind regards</p>`;
      try {
        await createDraftMessage(user.userId, draftSubject, bodyHtml);
        drafted = true;
      } catch {
        drafted = false;
      }
    }

    await writeAudit({
      tenantId: user.tenantId,
      matterId,
      actorUserId: user.userId,
      actionType: 'FILE_PROCESSED',
      actionStatus: 'SUCCESS',
      payload: { fileName: body.fileName, documentType, readable, substantive, trackerUpdated, drafted },
    });

    return ok({
      trackerUpdated,
      documentType: documentType || null,
      substantive,
      drafted,
      draftSubject,
      reason: substantive
        ? null
        : readable
        ? 'File looks empty or uninformative — logged to the tracker, no notification drafted.'
        : 'This file type can’t be auto-read — logged to the tracker; draft an update manually if needed.',
    });
  } catch (error) {
    return fail(error);
  }
}
