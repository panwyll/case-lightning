/**
 * Logging a matter file to the tracker, with a rationally-gated "we now hold X"
 * draft notification. Shared by the process-existing-file and upload paths.
 *
 * Gating: the tracker is ALWAYS updated (a real file landed), but the draft is
 * only created for files we can actually read and confirm carry substantive
 * content (PDFs, via Claude). Unreadable types (e.g. .docx) and empty/placeholder
 * files are logged and flagged for a human — so an empty contract.docx never
 * triggers a false "we've got the contract" email. Drafts are never sent.
 */
import { query, queryOne } from './db';
import { downloadDriveItem, appendTrackerRow, createDraftMessage } from './graph';
import { reviewDocument } from './ai';
import { writeAudit } from './audit';

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

export interface ProcessFileResult {
  trackerUpdated: boolean;
  documentType: string | null;
  substantive: boolean;
  drafted: boolean;
  draftSubject: string | null;
  reason: string | null;
}

export async function processMatterFile(
  user: { userId: string; tenantId: string },
  matterId: string,
  opts: { itemId: string; fileName: string; mimeType?: string | null; bytes?: Buffer }
): Promise<ProcessFileResult> {
  const matter = await queryOne<{
    folder_path: string | null;
    tracker_item_id: string | null;
    matter_ref: string;
    property_address: string | null;
  }>(
    `select folder_path, tracker_item_id, matter_ref, property_address from matter where id = $1 and tenant_id = $2`,
    [matterId, user.tenantId]
  );
  if (!matter) throw new Error('Matter not found');

  const buffer = opts.bytes ?? (await downloadDriveItem(user.userId, opts.itemId));
  const isPdf = opts.mimeType === 'application/pdf' || /\.pdf$/i.test(opts.fileName);

  // Read + classify only what we can verify (PDF via Claude); anything else is
  // logged but never auto-notified.
  let documentType = '';
  let substantive = false;
  let readable = false;
  if (isPdf) {
    try {
      const { review } = await reviewDocument({
        userId: user.userId,
        tenantId: user.tenantId,
        matterId,
        fileName: opts.fileName,
        mimeType: 'application/pdf',
        pdfBase64: buffer.toString('base64'),
        expectations:
          'Identify the document type and whether it carries substantive content (as opposed to an empty, blank, or placeholder file).',
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
    [matterId, user.tenantId, opts.itemId]
  );
  if (!existing) {
    await query(
      `insert into document (tenant_id, matter_id, source_type, graph_item_id, storage_path, file_name, mime_type, doc_type, created_by)
       values ($1,$2,'ONEDRIVE_UPLOAD',$3,$4,$5,$6,$7,$8)`,
      [
        user.tenantId,
        matterId,
        opts.itemId,
        matter.folder_path ? `${matter.folder_path}/${opts.fileName}` : opts.fileName,
        opts.fileName,
        opts.mimeType ?? null,
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
      detail: `Received file: ${opts.fileName}${substantive ? '' : readable ? ' (appears empty/uninformative)' : ''}`,
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
      `<strong>${escapeHtml(documentType)}</strong> (${escapeHtml(opts.fileName)}).</p>` +
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
    payload: { fileName: opts.fileName, documentType, readable, substantive, trackerUpdated, drafted },
  });

  return {
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
  };
}
