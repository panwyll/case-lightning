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
import { downloadDriveItem, appendTrackerRow, createDraftMessage, listMessageAttachments, listMessageAttachmentsMeta, uploadToMatterFolder } from './graph';
import { reviewDocument, upsertChunks } from './ai';
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

/**
 * Reviews an email's attachments against the matter and returns a compact context
 * block to fold into a reply draft — so "reply to a document for review" actually
 * reads the document. PDFs only (Claude reads them); capped at 2 to bound cost;
 * best-effort (returns '' when nothing readable). Drives the "consider attachments
 * in the reply" behaviour from both the assist precompute and manual re-drafts.
 */
export async function reviewAttachmentsContext(
  user: { userId: string; tenantId: string },
  matterId: string,
  messageId: string
): Promise<string> {
  const attachments = await listMessageAttachments(user.userId, messageId).catch(() => [] as any[]);
  const pdfs = attachments
    .filter((a: any) => a.contentBytes && a.name && !a.isInline && (a.contentType === 'application/pdf' || /\.pdf$/i.test(a.name)))
    .slice(0, 2);
  if (!pdfs.length) return '';
  const parts: string[] = [];
  for (const a of pdfs) {
    try {
      const { review } = await reviewDocument({
        userId: user.userId,
        tenantId: user.tenantId,
        matterId,
        fileName: a.name,
        mimeType: 'application/pdf',
        pdfBase64: a.contentBytes,
        expectations:
          'Review this attached document against the matter. Surface what should shape the reply: key terms, any mismatch or missing item vs the matter, risks, and required next actions.',
        retrievedContext: '',
      });
      const risks = (review.risks ?? []).map((r: { severity: string; issue: string }) => `${r.severity}: ${r.issue}`).join('; ');
      const checks = (review.consistencyChecks ?? [])
        .filter((c: { status: string }) => c.status === 'MISMATCH' || c.status === 'MISSING')
        .map((c: { field: string; status: string }) => `${c.field} (${c.status})`)
        .join('; ');
      parts.push(
        `ATTACHED DOCUMENT — ${a.name} [${review.documentType ?? 'document'}]: ${review.summary ?? ''}` +
          (risks ? ` Risks: ${risks}.` : '') +
          (checks ? ` Discrepancies vs matter: ${checks}.` : '')
      );
    } catch {
      /* unreadable / provider can't read PDFs — skip */
    }
  }
  return parts.length ? `ATTACHMENT REVIEW (consider in the reply):\n${parts.join('\n---\n')}` : '';
}

/**
 * Ground truth about what is *actually* attached to an email, so the drafter never
 * pretends to have received documents that aren't there. `hasAttachments === false`
 * short-circuits without a Graph call; otherwise we list the (non-inline) names.
 */
export async function attachmentGroundTruth(
  userId: string,
  messageId: string | null | undefined,
  opts: { hasAttachments?: boolean } = {}
): Promise<string> {
  if (!messageId) return '';
  if (opts.hasAttachments === false) {
    return 'ATTACHMENTS: this email has NONE attached.';
  }
  const meta = await listMessageAttachmentsMeta(userId, messageId).catch(() => [] as any[]);
  if (!meta.length) return 'ATTACHMENTS: this email has NONE attached.';
  const names = meta.map((a: any) => a.name).filter(Boolean).join(', ');
  return `ATTACHMENTS actually present on this email: ${names}.`;
}

/**
 * Auto-saves a matched email's attachments into the matter's OneDrive folder
 * (records each as a document + RAG chunk, and notes the save on the tracker).
 * Called from the triage webhook when an incoming email matches a matter — so
 * "docs received by email on matched cases" always land in the folder without a
 * manual step. Idempotent on (matter, file name); best-effort. Returns the count.
 */
export async function saveEmailAttachmentsToMatter(
  user: { userId: string; tenantId: string },
  matterId: string,
  messageId: string,
  subject?: string
): Promise<number> {
  const matter = await queryOne<{ folder_path: string | null; tracker_item_id: string | null }>(
    `select folder_path, tracker_item_id from matter where id = $1 and tenant_id = $2`,
    [matterId, user.tenantId]
  );
  if (!matter?.folder_path) return 0;

  const attachments = await listMessageAttachments(user.userId, messageId);
  let saved = 0;
  for (const att of attachments) {
    if (!att.contentBytes || !att.name || att.isInline) continue;
    const exists = await queryOne<{ id: string }>(
      `select id from document where matter_id = $1 and tenant_id = $2 and file_name = $3`,
      [matterId, user.tenantId, att.name]
    );
    if (exists) continue; // already in the folder — don't re-save on a re-triage
    const buffer = Buffer.from(att.contentBytes, 'base64');
    const uploaded = await uploadToMatterFolder(user.userId, matter.folder_path, att.name, buffer);
    const doc = await queryOne<{ id: string }>(
      `insert into document
        (tenant_id, matter_id, source_type, drive_id, graph_item_id, storage_path, web_url, file_name, mime_type, size_bytes, doc_type, created_by)
       values ($1,$2,'EMAIL_ATTACHMENT',$3,$4,$5,$6,$7,$8,$9,'EMAIL_ATTACHMENT',$10) returning id`,
      [
        user.tenantId,
        matterId,
        uploaded.parentReference?.driveId ?? null,
        uploaded.id,
        `${matter.folder_path}/${att.name}`,
        uploaded.webUrl ?? null,
        att.name,
        att.contentType ?? null,
        att.size ?? null,
        user.userId,
      ]
    );
    await upsertChunks({
      tenantId: user.tenantId,
      matterId,
      sourceKind: 'DOCUMENT',
      sourceId: doc!.id,
      text: `${att.name}\n${att.contentType ?? ''}`,
      metadata: { fileName: att.name, graphItemId: uploaded.id, source: 'EMAIL_ATTACHMENT' },
    }).catch(() => {});
    saved += 1;
  }

  if (saved > 0 && matter.tracker_item_id) {
    await appendTrackerRow(user.userId, matter.tracker_item_id, {
      date: new Date().toISOString().slice(0, 10),
      type: 'DOC_SAVED',
      detail: `Auto-saved ${saved} attachment(s) from email: ${subject ?? ''}`.slice(0, 250),
      owner: '',
      due: '',
      status: 'DONE',
    }).catch(() => {});
  }

  if (saved > 0) {
    await writeAudit({
      tenantId: user.tenantId,
      matterId,
      actorUserId: user.userId,
      actionType: 'EMAIL_SAVED_TO_MATTER',
      actionStatus: 'SUCCESS',
      payload: { messageId, count: saved, auto: true },
    }).catch(() => {});
  }
  return saved;
}
