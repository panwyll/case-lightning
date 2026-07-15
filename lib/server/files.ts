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
import crypto from 'node:crypto';
import PizZip from 'pizzip';
import { query, queryOne } from './db';
import { downloadDriveItem, appendTrackerRow, createDraftMessage, listMessageAttachments, listMessageAttachmentsMeta, uploadToMatterKb, matterKbPath } from './graph';
import { addDraftReady } from './worklist';
import { reviewDocument, upsertChunks } from './ai';
import { writeAudit } from './audit';
import { emitMatterEvent } from './events';

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
  const isImage = /^image\/(png|jpe?g|gif|webp)$/i.test(opts.mimeType || '') || /\.(png|jpe?g|gif|webp)$/i.test(opts.fileName);

  // Read + classify what we can verify (PDFs and images via Claude); anything else
  // is logged but never auto-notified.
  let documentType = '';
  let substantive = false;
  let readable = false;
  let indexText = ''; // document content to embed into the matter's RAG index
  if (isPdf || isImage) {
    try {
      const { review } = await reviewDocument({
        userId: user.userId,
        tenantId: user.tenantId,
        matterId,
        fileName: opts.fileName,
        ...(isPdf
          ? { pdfBase64: buffer.toString('base64'), mimeType: 'application/pdf' }
          : { imageBase64: buffer.toString('base64'), mimeType: opts.mimeType || 'image/jpeg' }),
        expectations:
          'Identify the document type and whether it carries substantive content (as opposed to an empty, blank, or placeholder file).',
        retrievedContext: '',
      });
      readable = true;
      documentType = (review.documentType || '').trim();
      const detail = (review.keyDetails?.length ?? 0) > 0 || (review.summary || '').trim().length > 40;
      substantive = !!documentType && detail;
      indexText = reviewToIndexText(review); // reuse this review — no second LLM call
    } catch {
      /* couldn't read it — fall through to log-only */
    }
  } else if (/\.docx$/i.test(opts.fileName) || opts.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    indexText = extractDocxText(buffer.toString('base64')).slice(0, 40000);
  } else if ((opts.mimeType || '').startsWith('text/') || /\.txt$/i.test(opts.fileName)) {
    indexText = buffer.toString('utf8').slice(0, 40000);
  }

  // Record the file so it isn't reprocessed (idempotent on graph_item_id).
  const existing = await queryOne<{ id: string }>(
    `select id from document where matter_id = $1 and tenant_id = $2 and graph_item_id = $3`,
    [matterId, user.tenantId, opts.itemId]
  );
  if (!existing) {
    const doc = await queryOne<{ id: string }>(
      `insert into document (tenant_id, matter_id, source_type, graph_item_id, storage_path, file_name, mime_type, hash_sha256, doc_type, created_by)
       values ($1,$2,'ONEDRIVE_UPLOAD',$3,$4,$5,$6,$7,$8,$9) returning id`,
      [
        user.tenantId,
        matterId,
        opts.itemId,
        matter.folder_path ? `${matter.folder_path}/${opts.fileName}` : opts.fileName,
        opts.fileName,
        opts.mimeType ?? null,
        crypto.createHash('sha256').update(buffer).digest('hex'),
        documentType || null,
        user.userId,
      ]
    );
    // Index the content so manually-added case files are searchable by the drafter.
    await upsertChunks({
      tenantId: user.tenantId,
      matterId,
      sourceKind: 'DOCUMENT',
      sourceId: doc!.id,
      text: indexText ? `${opts.fileName}\n${indexText}` : `${opts.fileName}\n${opts.mimeType ?? ''}`,
      metadata: { fileName: opts.fileName, graphItemId: opts.itemId, source: 'ONEDRIVE_UPLOAD', indexed: indexText ? 'content' : 'name' },
    }).catch(() => {});
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
      const draft = await createDraftMessage(user.userId, draftSubject, bodyHtml);
      drafted = true;
      // Surface the acknowledgement on the "ready to send" worklist, carrying the draft's
      // id so it can be sent in one click from the pane (no thread — a portal download /
      // manual upload has no inbound email).
      await addDraftReady({
        tenantId: user.tenantId,
        matterId,
        dedupKey: `doc:${opts.itemId}`,
        title: `Acknowledgement drafted — ${documentType} received`,
        detail: draftSubject,
        graphMessageId: (draft?.id as string) ?? null,
      });
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
export interface AttachmentDoc { name: string; docType: string; summary: string }
/** Review a message's attachments once, returning both a per-document summary (for the UI)
 *  and the context blob used to ground a reply. */
export async function summarizeAttachments(
  user: { userId: string; tenantId: string },
  matterId: string,
  messageId: string
): Promise<{ documents: AttachmentDoc[]; context: string }> {
  const attachments = await listMessageAttachments(user.userId, messageId).catch(() => [] as any[]);
  const reviewable = attachments
    .filter((a: any) => a.contentBytes && a.name && !a.isInline)
    .filter((a: any) => {
      const n = (a.name as string).toLowerCase();
      return (
        a.contentType === 'application/pdf' || n.endsWith('.pdf') ||
        n.endsWith('.docx') || a.contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        /^image\/(png|jpe?g|gif|webp)$/i.test(a.contentType || '') || /\.(png|jpe?g|gif|webp)$/i.test(n) ||
        (typeof a.contentType === 'string' && a.contentType.startsWith('text/')) || n.endsWith('.txt')
      );
    })
    .slice(0, 3);
  if (!reviewable.length) return { documents: [], context: '' };
  const parts: string[] = [];
  const documents: AttachmentDoc[] = [];
  for (const a of reviewable) {
    const name = a.name as string;
    const lower = name.toLowerCase();
    const isPdf = a.contentType === 'application/pdf' || lower.endsWith('.pdf');
    const isDocx = lower.endsWith('.docx') || a.contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const isImage = /^image\/(png|jpe?g|gif|webp)$/i.test(a.contentType || '') || /\.(png|jpe?g|gif|webp)$/i.test(lower);
    try {
      // PDFs → document block; images → vision; .docx/text → extracted plain text.
      const docInput: { pdfBase64?: string; imageBase64?: string; documentText?: string; mimeType: string } = isPdf
        ? { pdfBase64: a.contentBytes, mimeType: 'application/pdf' }
        : isImage
        ? { imageBase64: a.contentBytes, mimeType: a.contentType || (lower.endsWith('.png') ? 'image/png' : 'image/jpeg') }
        : isDocx
        ? { documentText: extractDocxText(a.contentBytes).slice(0, 40000), mimeType: 'text/plain' }
        : { documentText: Buffer.from(a.contentBytes, 'base64').toString('utf8').slice(0, 40000), mimeType: 'text/plain' };
      if (!isPdf && !isImage && !docInput.documentText?.trim()) continue; // empty/unreadable doc
      const { review } = await reviewDocument({
        userId: user.userId,
        tenantId: user.tenantId,
        matterId,
        fileName: name,
        ...docInput,
        expectations:
          'Review this attached document against the matter. Surface what should shape the reply: key terms, whether the document actually contains the substantive detail it purports to (not just a title/placeholder), any mismatch or missing item vs the matter, risks, and required next actions.',
        retrievedContext: '',
      });
      const risks = (review.risks ?? []).map((r: { severity: string; issue: string }) => `${r.severity}: ${r.issue}`).join('; ');
      const checks = (review.consistencyChecks ?? [])
        .filter((c: { status: string }) => c.status === 'MISMATCH' || c.status === 'MISSING')
        .map((c: { field: string; status: string }) => `${c.field} (${c.status})`)
        .join('; ');
      if (review.summary) documents.push({ name, docType: review.documentType ?? 'Document', summary: [review.summary, risks ? `⚠ ${risks}` : '', checks ? `Doesn’t match the matter: ${checks}` : ''].filter(Boolean).join(' ') });
      parts.push(
        `ATTACHED DOCUMENT — ${name} [${review.documentType ?? 'document'}]: ${review.summary ?? ''}` +
          (risks ? ` Risks: ${risks}.` : '') +
          (checks ? ` Discrepancies vs matter: ${checks}.` : '')
      );
    } catch {
      /* unreadable / provider can't read this type — skip */
    }
  }
  return { documents, context: parts.length ? `ATTACHMENT REVIEW (consider in the reply):\n${parts.join('\n---\n')}` : '' };
}

/** Back-compat: the reply-drafting paths only need the context blob. */
export async function reviewAttachmentsContext(
  user: { userId: string; tenantId: string },
  matterId: string,
  messageId: string
): Promise<string> {
  return (await summarizeAttachments(user, matterId, messageId)).context;
}

/** Best-effort plain-text extraction from a base64 .docx (word/document.xml). */
function extractDocxText(base64: string): string {
  try {
    const zip = new PizZip(Buffer.from(base64, 'base64'));
    const xml = zip.file('word/document.xml')?.asText() ?? '';
    return xml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return '';
  }
}

/** Compact, retrieval-friendly text from a document review (type + summary + facts). */
function reviewToIndexText(review: {
  documentType?: string;
  summary?: string;
  keyDetails?: Array<{ label: string; value: string }>;
}): string {
  const details = (review.keyDetails ?? []).map((k) => `${k.label}: ${k.value}`).join('; ');
  return [`[${review.documentType ?? 'document'}] ${review.summary ?? ''}`.trim(), details].filter(Boolean).join('\n').slice(0, 40000);
}

/**
 * Text to EMBED for a saved document, so the matter's RAG index knows its content
 * (not just its filename). docx/text are extracted locally; PDFs and images are
 * summarised by Claude into a compact, salient representation that retrieves well.
 * Best-effort — returns '' when nothing can be read.
 */
async function buildDocIndexText(
  user: { userId: string; tenantId: string },
  matterId: string,
  fileName: string,
  contentType: string | null | undefined,
  base64: string
): Promise<string> {
  const lower = fileName.toLowerCase();
  const ct = (contentType || '').toLowerCase();
  try {
    if (lower.endsWith('.docx') || ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return extractDocxText(base64).slice(0, 40000);
    }
    if (ct.startsWith('text/') || lower.endsWith('.txt')) {
      return Buffer.from(base64, 'base64').toString('utf8').slice(0, 40000);
    }
    const isPdf = ct === 'application/pdf' || lower.endsWith('.pdf');
    const isImage = /^image\/(png|jpe?g|gif|webp)$/i.test(ct) || /\.(png|jpe?g|gif|webp)$/i.test(lower);
    if (isPdf || isImage) {
      const { review } = await reviewDocument({
        userId: user.userId,
        tenantId: user.tenantId,
        matterId,
        fileName,
        ...(isPdf
          ? { pdfBase64: base64, mimeType: 'application/pdf' }
          : { imageBase64: base64, mimeType: contentType || 'image/jpeg' }),
        expectations:
          'Identify this document and capture its substantive content for a searchable case index: the type, a faithful summary, and the key details (dates, amounts, parties, addresses, references).',
        retrievedContext: '',
      });
      return reviewToIndexText(review);
    }
  } catch {
    /* unreadable / provider can’t read it — fall back to filename-only index */
  }
  return '';
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
  const savedNames: string[] = [];
  for (const att of attachments) {
    if (!att.contentBytes || !att.name || att.isInline) continue;
    const buffer = Buffer.from(att.contentBytes, 'base64');
    // Content-address by SHA-256: dedup on the bytes, not the filename — so a
    // renamed duplicate is skipped, while a changed file sharing a name is treated
    // as genuinely new (the old filename check silently dropped updated files).
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const exists = await queryOne<{ id: string }>(
      `select id from document where matter_id = $1 and tenant_id = $2 and hash_sha256 = $3`,
      [matterId, user.tenantId, hash]
    );
    if (exists) continue; // identical content already filed
    const uploaded = await uploadToMatterKb(user.userId, matter.folder_path, att.name, buffer);
    const doc = await queryOne<{ id: string }>(
      `insert into document
        (tenant_id, matter_id, source_type, drive_id, graph_item_id, storage_path, web_url, file_name, mime_type, size_bytes, hash_sha256, doc_type, created_by)
       values ($1,$2,'EMAIL_ATTACHMENT',$3,$4,$5,$6,$7,$8,$9,$10,'EMAIL_ATTACHMENT',$11) returning id`,
      [
        user.tenantId,
        matterId,
        uploaded.parentReference?.driveId ?? null,
        uploaded.id,
        `${matterKbPath(matter.folder_path)}/${att.name}`,
        uploaded.webUrl ?? null,
        att.name,
        att.contentType ?? null,
        att.size ?? null,
        hash,
        user.userId,
      ]
    );
    // Index the document's CONTENT (not just its filename) so the drafter is
    // case-aware across the matter's documents, not only the current email.
    const indexText = await buildDocIndexText(user, matterId, att.name, att.contentType, att.contentBytes);
    await upsertChunks({
      tenantId: user.tenantId,
      matterId,
      sourceKind: 'DOCUMENT',
      sourceId: doc!.id,
      text: indexText ? `${att.name}\n${indexText}` : `${att.name}\n${att.contentType ?? ''}`,
      metadata: { fileName: att.name, graphItemId: uploaded.id, source: 'EMAIL_ATTACHMENT', indexed: indexText ? 'content' : 'name' },
    }).catch(() => {});
    saved += 1;
    savedNames.push(att.name);
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
    // Proactive loop: a document landing is inherently noteworthy — record it on the
    // timeline and brief the fee-earner (dedup so the same batch never notifies twice).
    const nameList = savedNames.length <= 2 ? savedNames.join(', ') : `${savedNames[0]} (+${savedNames.length - 1} more)`;
    await emitMatterEvent({
      tenantId: user.tenantId,
      matterId,
      eventType: 'DOC_RECEIVED',
      title: `Received ${saved} document(s): ${nameList}`,
      details: subject ?? null,
      notify: {
        kind: 'DOC_RECEIVED',
        headline: `New document${saved > 1 ? 's' : ''} received: ${nameList}`,
        did: 'Filed it to the matter folder and indexed it for the drafter',
        action: 'Review it and update the client if needed',
        dedupKey: `doc:${matterId}:${messageId}`,
      },
    }).catch(() => {});
  }
  return saved;
}
