/**
 * Logging a matter file (document record, RAG index, timeline), with a rationally-gated
 * "we now hold X" draft notification. Shared by the process-existing-file and upload paths.
 *
 * Gating: the file is ALWAYS recorded (a real file landed), but the draft is
 * only created for files we can actually read and confirm carry substantive
 * content (PDFs, via Claude). Unreadable types (e.g. .docx) and empty/placeholder
 * files are logged and flagged for a human — so an empty contract.docx never
 * triggers a false "we've got the contract" email. Drafts are never sent.
 */
import crypto from 'node:crypto';
import { putBlob } from './blob-store';
import PizZip from 'pizzip';
import { query, queryOne } from './db';
import { downloadDriveItem, createDraftMessage, listMessageAttachments, listMessageAttachmentsMeta, uploadToMatterKb, matterKbPath } from './graph';
import { addDraftReady } from './worklist';
import { reviewDocument, upsertChunks } from './ai';
import { stripHtml, htmlToText, newWordsOf } from './text';
import { driveUserFor } from './matter-drive';
import { writeAudit } from './audit';
import { isLockedPdf, passwordCandidates } from './pdf-lock';
import { expandZip, isZip, type ZipResult } from './zip-expand';
import { recordLockedDocument, tryPasswordsFromMessage } from './document-unlock';
import { emitMatterEvent } from './events';
import { ingestFiledDocument } from './engine/ingest-hook';
import { tenantSelfAddresses } from './matching';
import type { NoteSender, SenderRelation } from './engine/types';
import { bankDetailsIn } from './engine/notes';

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

export interface ProcessFileResult {
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
    matter_ref: string;
    property_address: string | null;
  }>(
    `select folder_path, matter_ref, property_address from matter where id = $1 and tenant_id = $2`,
    [matterId, user.tenantId]
  );
  if (!matter) throw new Error('Case not found');

  const buffer = opts.bytes ?? (await downloadDriveItem(user.userId, opts.itemId));
  const isPdf = opts.mimeType === 'application/pdf' || /\.pdf$/i.test(opts.fileName);
  const isImage = /^image\/(png|jpe?g|gif|webp)$/i.test(opts.mimeType || '') || /\.(png|jpe?g|gif|webp)$/i.test(opts.fileName);

  // Read + classify what we can verify (PDFs and images via Claude); anything else
  // is logged but never auto-notified.
  let documentType = '';
  let substantive = false;
  let readable = false;
  let indexText = ''; // document content to embed into the matter's RAG index
  const locked = isPdf && (await isLockedPdf(buffer).catch(() => false));
  if (locked) {
    // Password-protected: nothing can be read until it is unlocked. Filed, marked, and a task asks for the password.
  } else if (isPdf || isImage) {
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

  // A file is known by its contents (SHA-256), never its name: an edited file is a new
  // version and is read again; identical bytes anywhere on the case are already there.
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = await queryOne<{ id: string }>(
    `select id from document where matter_id = $1 and tenant_id = $2 and hash_sha256 = $3 and superseded_at is null`,
    [matterId, user.tenantId, hash]
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
        hash,
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
    // An edited OneDrive file (the same item) or a revised copy of a document already on the case becomes its current version.
    const prior = doc?.id ? await supersedeAsVersion(user.tenantId, matterId, doc.id, { fileName: opts.fileName, graphItemId: opts.itemId }).catch(() => null) : null;
    if (doc?.id && locked) {
      if (opts.bytes) await putBlob(user.tenantId, doc.id, opts.bytes).catch(() => {});
      await recordLockedDocument(user.tenantId, matterId, doc.id, opts.fileName);
      return { documentType: null, substantive: false, drafted: false, draftSubject: null, reason: 'password-protected: a task asks for the password' };
    }
    // Conveyancing engine (component #2): classify + route the new document into the
    // matter's sub-flows. No-op unless the matter is enrolled; never fails the filing.
    if (doc?.id) {
      const report = await ingestFiledDocument(user.tenantId, matterId, doc.id).catch(() => null);
      if (prior) await surfaceRevision(user.tenantId, matterId, opts.fileName, doc.id, prior, report).catch(() => {});
    }
  }

  // Gate the notification: only draft for files we read and confirmed substantive.
  let drafted = false;
  let draftSubject: string | null = null;
  if (substantive) {
    const where = matter.property_address ? ` (${matter.property_address})` : '';
    draftSubject = `${matter.matter_ref} — ${documentType} received`;
    const bodyHtml =
      `<p>Dear Sir or Madam,</p>` +
      `<p>We confirm that we now hold the following document on the above case${escapeHtml(where)}: ` +
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
    payload: { fileName: opts.fileName, documentType, readable, substantive, drafted },
  });

  return {
    documentType: documentType || null,
    substantive,
    drafted,
    draftSubject,
    reason: substantive
      ? null
      : readable
      ? 'File looks empty or uninformative — filed, no notification drafted.'
      : 'This file type can’t be auto-read — filed; draft an update manually if needed.',
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
  const listed = await listMessageAttachments(user.userId, messageId).catch(() => [] as any[]);
  // What is inside a zip is what was sent: the drafter sees those files, not the archive.
  const attachments: any[] = [];
  for (const a of listed) {
    const buf = a.contentBytes ? Buffer.from(a.contentBytes, 'base64') : null;
    if (buf && isZip(a.name, a.contentType, buf)) {
      const z = await expandZip(buf).catch(() => null);
      if (z && !z.error) { for (const e of z.entries) attachments.push({ name: e.name, contentType: e.contentType, contentBytes: e.bytes.toString('base64'), isInline: false }); continue; }
    }
    attachments.push(a);
  }
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
      if (review.summary) documents.push({ name, docType: review.documentType ?? 'Document', summary: [review.summary, risks ? `⚠ ${risks}` : '', checks ? `Doesn’t match the case: ${checks}` : ''].filter(Boolean).join(' ') });
      parts.push(
        `ATTACHED DOCUMENT — ${name} [${review.documentType ?? 'document'}]: ${review.summary ?? ''}` +
          (risks ? ` Risks: ${risks}.` : '') +
          (checks ? ` Discrepancies vs case: ${checks}.` : '')
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
    // A PDF that carries its own text is indexed from that text: no model call. Only scans and pictures are read.
    if (isPdf) {
      const { pdfPageTexts } = await import('./engine/review');
      const t = await pdfPageTexts(Buffer.from(base64, 'base64')).catch(() => ({ pages: [] as string[], textLayer: false }));
      const thin = t.pages.filter((p) => p.trim().length < 40).length;
      if (t.pages.length && thin / t.pages.length <= 0.2) return t.pages.join('\n\n').slice(0, 40000);
    }
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
 * (records each as a document + RAG chunk).
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
  return (await fileEmailAttachments(user, matterId, messageId, subject)).saved;
}

/** "Contract v2 (1).pdf" and "contract-final.pdf" are the same document as "Contract.pdf"; "scan.pdf" is nobody's name for anything. */
export function versionKey(fileName: string): string | null {
  const m = fileName.toLowerCase().match(/^(.*?)(\.[a-z0-9]{1,5})?$/);
  const ext = m?.[2] ?? '';
  const stem = (m?.[1] ?? '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\(\d+\)/g, ' ')
    .replace(/[\s_\-.]*(v|ver|version|rev|revision)[\s_\-.]*[\da-z]{0,3}\b/g, ' ')
    .replace(/\b(final|revised|amended|updated|latest|draft|copy|signed|clean|tracked)\b/g, ' ')
    .replace(/[\s_\-.]+/g, ' ')
    .trim();
  if (!stem || /^(scan|scanned|document|doc|image|img|attachment|untitled|file|print|page|photo|pdf|\d+|img \d+|dsc \d+|scan \d+|doc \d+)$/.test(stem)) return null;
  return `${stem}${ext}`;
}

/**
 * A new file that is a revision of one already on the case (the same OneDrive item edited, or
 * the same document name sent again with different contents) replaces it as the current
 * version. The earlier one stays on file, superseded, and is what the new reading is compared with.
 */
export async function supersedeAsVersion(tenantId: string, matterId: string, newDocId: string, of: { fileName: string; graphItemId?: string | null }): Promise<{ id: string; fileName: string | null; at: string; read: boolean } | null> {
  const key = versionKey(of.fileName);
  const candidates = await query<{ id: string; file_name: string | null; graph_item_id: string | null; created_at: string }>(
    `select id, file_name, graph_item_id, created_at::text from document where tenant_id = $1 and matter_id = $2 and id <> $3 and superseded_at is null and file_name is not null order by created_at desc limit 300`,
    [tenantId, matterId, newDocId]
  ).catch(() => []);
  const prior = candidates.find((c) => (of.graphItemId && c.graph_item_id === of.graphItemId) || (key && c.file_name && versionKey(c.file_name) === key));
  if (!prior) return null;
  await query(`update document set superseded_at = now(), superseded_by = $3 where id = $1 and tenant_id = $2`, [prior.id, tenantId, newDocId]).catch(() => {});
  await query(`delete from kb_chunk where tenant_id = $1 and source_kind in ('DOCUMENT', 'DOCUMENT_PAGE') and source_id = $2`, [tenantId, prior.id]).catch(() => {});
  const cited = await queryOne<{ n: string }>(`select count(*)::text as n from matter_event where tenant_id = $1 and matter_id = $2 and source_document_id = $3`, [tenantId, matterId, prior.id]).catch(() => ({ n: '0' }));
  return { id: prior.id, fileName: prior.file_name, at: prior.created_at, read: Number(cited?.n ?? '0') > 0 };
}

/** After a revision is read: say what happened, and when the case could not simply take it, give it to a person. */
async function surfaceRevision(tenantId: string, matterId: string, fileName: string, newDocId: string, prior: { fileName: string | null; at: string; read: boolean }, report: { action: { kind: string; reason?: string }; classification?: { role: string } | null } | null): Promise<{ outcome: 'read' | 'filed'; as: string | null; reason: string }> {
  const when = new Date(prior.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  const replaces = `a new version of ${prior.fileName ?? 'a document'} (the version from ${when} is kept, superseded)`;
  const role = report?.classification?.role ?? null;
  // What changed between the two readings (the reader compares a new version with the one it replaces).
  const d = await queryOne<{ diff: { changed?: Array<{ key: string; from: string; to: string }>; added?: Array<{ key: string; value: string }>; removed?: Array<{ key: string; value: string }> } | null }>(`select review_diff as diff from document where id = $1 and tenant_id = $2`, [newDocId, tenantId]).catch(() => null);
  const label = (k: string) => k.replace(/^[a-z_]+\./, '').replace(/[._]/g, ' ');
  const changes = [
    ...(d?.diff?.changed ?? []).map((c) => `${label(c.key)}: ${c.from} → ${c.to}`),
    ...(d?.diff?.added ?? []).map((a) => `${label(a.key)} added: ${a.value}`),
    ...(d?.diff?.removed ?? []).map((r) => `${label(r.key)} gone (was ${r.value})`),
  ];
  const changedText = changes.length ? `What changed: ${changes.slice(0, 12).join('; ')}${changes.length > 12 ? `; and ${changes.length - 12} more` : ''}.` : d?.diff ? 'The facts read from it are the same as the earlier version.' : 'The two versions could not be compared fact by fact.';
  const applied = !!report && report.action.kind !== 'skip';
  // A person sees every revision that changed something, and every one the system could not re-apply.
  if (prior.read && (!applied || changes.length)) {
    const { engine } = await import('./engine/adapters');
    await engine().run(tenantId, matterId, { type: 'raise_issue', actor: 'system', kind: 'document_revised', title: `Revised: ${fileName} replaces the version from ${when}`, detail: `${changedText}${applied ? '' : ` The system could not simply re-apply it${report?.action.kind === 'skip' && report.action.reason ? ` (${report.action.reason})` : ''}.`} Decide whether the change affects advice, enquiries or the report.`, gate: 'none', documentId: newDocId } as never).catch((e) => console.error('[files] revision issue could not be raised', (e as Error).message));
    return { outcome: applied ? 'read' : 'filed', as: role && role !== 'other' ? role : null, reason: `${replaces}. ${changedText} A task asks you to check it` };
  }
  if (applied) return { outcome: 'read', as: role, reason: `${replaces}. ${changedText}` };
  return { outcome: 'filed', as: role && role !== 'other' ? role : null, reason: `${replaces}; ${report?.action.kind === 'skip' && report.action.reason ? report.action.reason : 'not acted on'}` };
}

/** One line per thing that happened to an email and its files, in plain words, for the case log. */
export function describeFiling(
  email: { outcome: string; as: string | null; reason: string | null; proposals?: number } | null,
  files: Array<{ name: string; outcome: string; as: string | null; reason: string | null }>,
  problems: string[]
): string[] {
  const as = (x: string | null) => (x ? x.replace(/_/g, ' ') : null);
  const lines: string[] = [];
  if (email) {
    if (email.outcome === 'read') lines.push(`Email processed${as(email.as) ? `: classified as ${as(email.as)}` : ''}.`);
    else if (email.outcome === 'noted') lines.push(email.proposals ? `Email processed: ${email.proposals} proposed action${email.proposals === 1 ? '' : 's'} awaiting review.` : 'Email processed: no actionable content.');
    else if (email.outcome === 'duplicate') lines.push('Email already on file.');
    else if (email.outcome === 'skipped') lines.push('Email has no body text to process.');
    else lines.push(`Email filed; not processed${email.reason ? `: ${email.reason}` : ''}.`);
  }
  for (const f of files) {
    if (f.outcome === 'read') lines.push(`${f.name}: processed${as(f.as) ? ` as ${as(f.as)}` : ''}.`);
    else if (f.outcome === 'locked') lines.push(`${f.name}: password-protected; password requested (task raised).`);
    else if (f.outcome === 'duplicate') lines.push(`${f.name}: already on file${as(f.as) ? ` (${as(f.as)})` : ''}; not re-processed${f.reason ? ` (${f.reason})` : ''}.`);
    else if (f.outcome === 'skipped') lines.push(`${f.name}: not filed: ${f.reason ?? 'reason not recorded'}.`);
    else if (f.outcome === 'expanded') lines.push(`${f.name}: archive opened; ${f.reason ?? 'contents extracted'}.`);
    else lines.push(`${f.name}: filed; not processed${f.reason ? `: ${f.reason}` : ''}.`);
  }
  return [...lines, ...problems];
}

/** What became of each attachment: filed and read into the case, filed but locked, or already there. */
/** An archive that could not be opened: a task asks for the files another way. */
async function raiseArchiveTask(tenantId: string, matterId: string, fileName: string, why: string): Promise<void> {
  const { engine } = await import('./engine/adapters');
  const { SYSTEM } = await import('./engine/types');
  const svc = engine();
  const s = await svc.getState(tenantId, matterId);
  if (!s.enrolled || s.completion.confirmedAt) return;
  const title = `Archive could not be opened: ${fileName}`;
  if (Object.values(s.issues).some((i) => i.status === 'open' && i.title === title)) return;
  await svc.run(tenantId, matterId, { type: 'raise_issue', actor: SYSTEM, kind: 'file_locked', title, detail: `${fileName}: ${why}.`, gate: 'none' });
}

export interface FiledAttachment { name: string; outcome: 'read' | 'locked' | 'filed' | 'duplicate' | 'skipped' | 'expanded'; as: string | null; reason: string | null }

export async function fileEmailAttachments(
  user: { userId: string; tenantId: string },
  matterId: string,
  messageId: string,
  subject?: string
): Promise<{ saved: number; files: FiledAttachment[] }> {
  const files: FiledAttachment[] = [];
  const matter = await queryOne<{ folder_path: string | null }>(
    `select folder_path from matter where id = $1 and tenant_id = $2`,
    [matterId, user.tenantId]
  );
  // A case without a OneDrive folder still files its attachments: the bytes live in the
  // database (document_blob, as a locked file or a provider download does) and are read,
  // shown and opened from there. Nothing is dropped for want of a folder.
  const folder = matter?.folder_path ?? null;
  // Files go to the matter's own drive, not the drive of whoever happened to
  // receive the email — otherwise a case's documents scatter across colleagues.
  const driveUser = folder ? await driveUserFor(user.tenantId, matterId, user.userId) : null;
  const attachments = await listMessageAttachments(user.userId, messageId);
  // One line per email so a skipped file can be diagnosed from the logs (names and shapes only, never contents).
  console.info(`[files] ${attachments.length} attachment(s) on the email for matter ${matterId}: ${attachments.map((a) => `${a.name ?? '?'} [${String(a['@odata.type'] ?? '').replace('#microsoft.graph.', '')} ${a.contentType ?? ''} ${a.size ?? '?'}B${a.isInline ? ' inline' : ''}${a.contentBytes ? '' : ' no-bytes'}${a.fetchError ? ` error: ${a.fetchError}` : ''}]`).join(', ') || 'none'}`);
  let saved = 0;
  const savedNames: string[] = [];
  for (const att of attachments) {
    const kind = String(att['@odata.type'] ?? '');
    const isImage = /^image\//i.test(att.contentType ?? '');
    // Signature logos are small inline images: not files anyone sent. A pasted photo or scan of a
    // document is an inline image too, but a big one, and it is filed like any attachment.
    if (att.isInline && isImage && (att.size ?? 0) < 60_000) continue;
    if (kind === '#microsoft.graph.referenceAttachment') { files.push({ name: att.name ?? 'a linked file', outcome: 'skipped', as: null, reason: 'it is a link to a file in someone\'s OneDrive, not the file itself; ask for it as an attachment' }); continue; }
    if (kind === '#microsoft.graph.itemAttachment') { files.push({ name: att.name ?? 'an attached email', outcome: 'skipped', as: null, reason: 'it is an email attached inside the email; open it in Outlook and file its attachments from there' }); continue; }
    if (!att.contentBytes || !att.name) { files.push({ name: att.name ?? 'an attachment', outcome: 'skipped', as: null, reason: att.fetchError ? `it could not be downloaded: ${att.fetchError}` : 'its contents could not be downloaded' }); continue; }
    const buffer = Buffer.from(att.contentBytes, 'base64');
    // A zip is opened: each file inside is filed and read in its own right (it joins this loop).
    if (!att.fromArchive && isZip(att.name, att.contentType, buffer)) {
      const z = await expandZip(buffer).catch((e: Error) => ({ entries: [], skipped: [], error: e.message }) as ZipResult);
      for (const e of z.entries) attachments.push({ '@odata.type': '#microsoft.graph.fileAttachment', name: e.name, contentType: e.contentType, size: e.bytes.length, contentBytes: e.bytes.toString('base64'), isInline: false, fromArchive: att.name });
      for (const sk of z.skipped) files.push({ name: `${sk.name} (in ${att.name})`, outcome: 'skipped', as: null, reason: sk.reason });
      if (!z.error) { files.push({ name: att.name, outcome: 'expanded', as: null, reason: `${z.entries.length} file${z.entries.length === 1 ? '' : 's'} extracted` }); continue; }
      // It could not be opened (an encrypted archive): not filed; a task asks for the files another way.
      files.push({ name: att.name, outcome: 'skipped', as: null, reason: z.error });
      await raiseArchiveTask(user.tenantId, matterId, att.name, z.error).catch(() => {});
      continue;
    }
    // Content-address by SHA-256: dedup on the bytes, not the filename — so a
    // renamed duplicate is skipped, while a changed file sharing a name is treated
    // as genuinely new (the old filename check silently dropped updated files).
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const exists = await queryOne<{ id: string }>(
      `select id from document where matter_id = $1 and tenant_id = $2 and hash_sha256 = $3`,
      [matterId, user.tenantId, hash]
    );
    if (exists) {
      // Identical content already filed. The copy we hold must open: if its bytes live only in a
      // OneDrive item (which may have been moved or deleted), keep these bytes against it now.
      for (const twin of await query<{ id: string }>(`select d.id from document d where d.tenant_id = $1 and d.matter_id = $3 and d.hash_sha256 = $2 and not exists (select 1 from document_blob b where b.document_id = d.id)`, [user.tenantId, hash, matterId]).catch(() => [])) {
        await putBlob(user.tenantId, twin.id, buffer, { mime: att.contentType ?? null }).catch((e) => console.error('[files] could not keep the bytes for a repeat file', (e as Error).message));
      }
      // If it was never read into the case (an earlier attempt filed it but the read failed or
      // was skipped), read it now instead of stopping at "duplicate".
      const cited = await queryOne<{ n: string; type: string | null; at: string | null }>(`select count(*)::text as n, max(type) as type, max(created_at)::text as at from matter_event where tenant_id = $1 and matter_id = $2 and source_document_id = $3`, [user.tenantId, matterId, exists.id]).catch(() => ({ n: '1', type: null, at: null }));
      if (Number(cited?.n ?? '1') > 0) {
        const readAs = cited?.type ? cited.type.replace(/_(received|extracted|returned)$/, '').replace(/_/g, ' ') : null;
        files.push({ name: att.name, outcome: 'duplicate', as: readAs, reason: cited?.at ? `read on ${new Date(cited.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}` : null });
        continue;
      }
      const report = await ingestFiledDocument(user.tenantId, matterId, exists.id).catch((e) => ({ failed: (e as Error).message }) as const);
      if (report && 'failed' in report) { files.push({ name: att.name, outcome: 'filed', as: null, reason: `already on the case, and could not be read: ${report.failed}` }); continue; }
      const role = report?.classification?.role ?? null;
      files.push(report && report.action.kind !== 'skip' ? { name: att.name, outcome: 'read', as: role, reason: null } : { name: att.name, outcome: 'filed', as: role && role !== 'other' ? role : null, reason: `already on the case; ${report?.action.kind === 'skip' ? report.action.reason : 'the case is not enrolled'}` });
      continue;
    }
    const uploaded = folder && driveUser ? await uploadToMatterKb(driveUser, folder, att.name, buffer) : null;
    const doc = await queryOne<{ id: string }>(
      `insert into document
        (tenant_id, matter_id, source_type, drive_id, graph_item_id, storage_path, web_url, file_name, mime_type, size_bytes, hash_sha256, doc_type, created_by)
       values ($1,$2,'EMAIL_ATTACHMENT',$3,$4,$5,$6,$7,$8,$9,$10,'EMAIL_ATTACHMENT',$11) returning id`,
      [
        user.tenantId,
        matterId,
        uploaded?.parentReference?.driveId ?? null,
        uploaded?.id ?? null,
        uploaded && folder ? `${matterKbPath(folder)}/${att.name}` : `email-attachment://${matterId}/${att.name}`,
        uploaded?.webUrl ?? null,
        att.name,
        att.contentType ?? null,
        att.size ?? null,
        hash,
        user.userId,
      ]
    );
    if (!uploaded && doc?.id) await putBlob(user.tenantId, doc.id, buffer).catch((e) => console.error('[files] attachment bytes could not be kept', (e as Error).message));
    // Index the document's CONTENT (not just its filename) so the drafter is
    // case-aware across the matter's documents, not only the current email.
    const indexText = await buildDocIndexText(user, matterId, att.name, att.contentType, att.contentBytes);
    await upsertChunks({
      tenantId: user.tenantId,
      matterId,
      sourceKind: 'DOCUMENT',
      sourceId: doc!.id,
      text: indexText ? `${att.name}\n${indexText}` : `${att.name}\n${att.contentType ?? ''}`,
      metadata: { fileName: att.name, graphItemId: uploaded?.id ?? null, source: 'EMAIL_ATTACHMENT', indexed: indexText ? 'content' : 'name' },
    }).then(async () => {
      // A revision of a document already on the case (same document name, new contents) becomes its current version.
    }).catch(() => {});
    saved += 1;
    savedNames.push(att.name);
    // Read into the case: a locked PDF becomes the password task; anything else is classified and routed to its sub-flow (title, search, forms…).
    if (doc?.id) {
      const isPdf = /pdf/i.test(att.contentType ?? '') || /\.pdf$/i.test(att.name);
      if (isPdf && (await isLockedPdf(buffer).catch(() => false))) {
        await putBlob(user.tenantId, doc.id, buffer).catch(() => {});
        await recordLockedDocument(user.tenantId, matterId, doc.id, att.name);
        files.push({ name: att.name, outcome: 'locked', as: null, reason: null });
      } else {
        const prior = await supersedeAsVersion(user.tenantId, matterId, doc.id, { fileName: att.name });
        const report = await ingestFiledDocument(user.tenantId, matterId, doc.id).catch((e) => { console.error('[files] ingest failed', att.name, (e as Error).message); return { failed: (e as Error).message } as const; });
        if (report && 'failed' in report) { files.push({ name: att.name, outcome: 'filed', as: null, reason: `could not be read: ${report.failed}` }); continue; }
        if (prior) { const r = await surfaceRevision(user.tenantId, matterId, att.name, doc.id, prior, report); files.push({ name: att.name, outcome: r.outcome, as: r.as, reason: r.reason }); continue; }
        const role = report?.classification?.role ?? null;
        files.push(report && report.action.kind !== 'skip' ? { name: att.name, outcome: 'read', as: role, reason: null } : { name: att.name, outcome: 'filed', as: role && role !== 'other' ? role : null, reason: report?.action.kind === 'skip' ? report.action.reason : 'the case is not enrolled' });
      }
    }
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
        did: 'Filed it to the case folder and indexed it for the drafter',
        action: 'Review it and update the client if needed',
        dedupKey: `doc:${matterId}:${messageId}`,
      },
    }).catch(() => {});
  }
  return { saved, files };
}

/**
 * Index an email's BODY into the matter's shared knowledge base.
 *
 * Attachments were already auto-filed on a trusted link, but the message text never
 * was — so the substance of a conversation stayed inside the one mailbox it arrived
 * in. In a firm where an assistant, a fee earner and a manager each hold part of the
 * correspondence, a colleague asked for an update could see that an email had been
 * triaged to the case, and read its attachments, but not what it actually said.
 * Thread bodies can't be fetched on their behalf either: listThreadMessages reads
 * the CALLING user's mailbox, so a thread living only in a colleague's inbox comes
 * back empty.
 *
 * Writing the body into kb_chunk (tenant + matter scoped) is what makes the case
 * record genuinely shared. No new Graph permission is involved: the message has
 * already been read, it simply wasn't being stored anywhere a colleague could reach.
 *
 * Gated on the same trusted link as attachment filing — a guessed match must never
 * write case content, since the reference it matched on lives in attacker-controlled
 * email text.
 */
export async function indexEmailBodyToMatter(
  user: { userId: string; tenantId: string },
  matterId: string,
  message: any
): Promise<boolean> {
  const body = stripHtml(message?.body?.content ?? '') || (message?.bodyPreview ?? '');
  if (!body.trim()) return false;
  // The password for a file that arrived recently often comes in the next message: try it, quietly.
  await tryPasswordsFromMessage(user.tenantId, matterId, body, passwordCandidates(body)).catch(() => []);

  const from = message?.from?.emailAddress?.address ?? 'unknown';
  const to = (message?.toRecipients ?? []).map((r: any) => r?.emailAddress?.address).filter(Boolean).join(', ');
  const when = message?.receivedDateTime ?? message?.sentDateTime ?? '';
  const text = `From: ${from}\nTo: ${to}\nDate: ${when}\nSubject: ${message?.subject ?? ''}\n\n${body}`.slice(0, 20000);

  try {
    await upsertChunks({
      tenantId: user.tenantId,
      matterId,
      sourceKind: 'EMAIL',
      text,
      metadata: {
        graphMessageId: message?.id ?? null,
        graphThreadId: message?.conversationId ?? null,
        subject: message?.subject ?? null,
        from,
        receivedAt: when || null,
        source: 'EMAIL_BODY_AUTO',
      },
    });
    return true;
  } catch {
    return false; // best-effort: never block triage on the index
  }
}

/**
 * Mark earlier versions of a just-filed document superseded, and drop their index
 * chunks so the drafter can't cite a stale figure from an old version.
 *
 * "Same document, new version" = same matter + same filename (case-insensitive),
 * different content — which is exactly what the hash-based dedupe already let
 * through as a new row. Within one matter, a reused filename is a new version of
 * the same thing (Contract.pdf → Contract.pdf), which is the intuitive behaviour.
 *
 * The old rows are KEPT (with superseded_at/superseded_by) for history and audit —
 * OneDrive holds the file's own version history too — but their kb_chunks are
 * deleted, because the index is derived and rebuildable and we want retrieval to
 * see only the current version. Best-effort; guarded so a pre-063 deploy no-ops.
 */
export async function supersedePriorVersions(
  tenantId: string,
  matterId: string,
  of: { graphItemId: string | null },
  newDocId: string
): Promise<number> {
  // Versions are the same file edited in place (one OneDrive item), never two files that share a name.
  if (!of.graphItemId) return 0;
  try {
    const prior = await query<{ id: string }>(
      `update document
          set superseded_at = now(), superseded_by = $4
        where tenant_id = $1 and matter_id = $2
          and graph_item_id = $3
          and id <> $4
          and superseded_at is null
        returning id`,
      [tenantId, matterId, of.graphItemId, newDocId]
    );
    if (prior.length) {
      const ids = prior.map((r) => r.id);
      // Remove the superseded versions' chunks from the searchable index.
      await query(
        `delete from kb_chunk where tenant_id = $1 and source_kind in ('DOCUMENT', 'DOCUMENT_PAGE') and source_id = any($2)`,
        [tenantId, ids]
      ).catch(() => {});
    }
    return prior.length;
  } catch {
    return 0; // pre-063: supersede columns not present
  }
}

/**
 * The email itself, read into the case. Replies to enquiries, a solicitor's answer, a lender's
 * confirmation — much of what moves a case arrives in the body of an email, not as a file.
 * On a trusted link the message text becomes a document on the case (From / To / Date /
 * Subject and the words), deduplicated on content, and goes through the same classify-and-route
 * step as a filed document. Returns what the reader made of it.
 */
export async function fileEmailBodyAsDocument(
  user: { userId: string; tenantId: string },
  matterId: string,
  message: any,
  attachments: Array<{ name: string; outcome: string; as: string | null }> = []
): Promise<{ outcome: 'read' | 'noted' | 'filed' | 'duplicate' | 'skipped'; as: string | null; reason: string | null; proposals?: number }> {
  const body = htmlToText(message?.body?.content ?? '') || (message?.bodyPreview ?? '');
  const fresh = newWordsOf(message ?? {});
  // Any words at all are read: "surveys are all complete" is a signal, not noise.
  if (!body.trim()) return { outcome: 'skipped', as: null, reason: 'the email has no body to read' };
  const from = message?.from?.emailAddress?.address ?? 'unknown';
  const fromName = message?.from?.emailAddress?.name ?? '';
  const to = (message?.toRecipients ?? []).map((r: any) => r?.emailAddress?.address).filter(Boolean).join(', ');
  const when = message?.receivedDateTime ?? message?.sentDateTime ?? new Date().toISOString();
  const subject = String(message?.subject ?? '(no subject)');
  const text = `From: ${fromName ? `${fromName} <${from}>` : from}\nTo: ${to}\nDate: ${when}\nSubject: ${subject}\n\n${body}`.slice(0, 60_000);
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const exists = await queryOne<{ id: string }>(`select id from document where matter_id = $1 and tenant_id = $2 and hash_sha256 = $3`, [matterId, user.tenantId, hash]).catch(() => null);
  if (exists) return { outcome: 'duplicate', as: null, reason: 'already on the case' };
  const { productionPorts } = await import('./engine/adapters');
  const slug = subject.toLowerCase().replace(/^(re|fw|fwd):\s*/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'email';
  const doc = await productionPorts().documents.createGenerated({ tenantId: user.tenantId, matterId, docType: 'EMAIL', fileName: `email-${String(when).slice(0, 10)}-${slug}.txt`, content: text, createdBy: user.userId });
  await query(`update document set hash_sha256 = $3, sender_domain = $4 where id = $1 and tenant_id = $2`, [doc.id, user.tenantId, hash, from.split('@')[1] ?? null]).catch(() => {});
  // A failure here must surface, not vanish: the caller records it on the case.
  const report = await ingestFiledDocument(user.tenantId, matterId, doc.id);
  const role = report?.classification?.role ?? null;
  if (report && report.action.kind !== 'skip') return { outcome: 'read', as: role, reason: null };
  // Not a document with a role, but words on a case: read them the way a file note is read.
  // Whatever they appear to say becomes a proposal for a person, gated by who sent it
  // (notes.ts senderPolicy); the case itself does not move until someone approves.
  const enrolled = report?.action.kind === 'skip' && !/not enrolled/.test(report.action.reason);
  if (enrolled && (!role || role === 'other') && (fresh || body).trim().length >= 2) {
    const { engine } = await import('./engine/adapters');
    const sender: NoteSender = { address: from, name: fromName || null, relation: await senderRelation(user.tenantId, matterId, from) };
    const res = await engine().recordNote(user.tenantId, matterId, { text: (fresh.length >= 2 ? fresh : body).slice(0, 20_000), kind: 'email', actor: user.userId, documentId: doc.id, from: sender, attachments: attachments.map((a) => `${a.name}${a.as ? ` (read as ${a.as.replace(/_/g, ' ')})` : a.outcome === 'duplicate' ? ' (already on the case)' : ''}`) });
    const note = Object.values(res.state.notes).find((n) => n.documentId === doc.id);
    let proposals = note?.actions.filter((a) => a.command).length ?? 0;
    // Bank details in an email are the fraud case: they go straight to the hard-stop bank-details
    // decision, with who sent them and how the case knows them, never into the notes.
    const bank = bankDetailsIn(fresh.length >= 2 ? fresh : body);
    if (bank) {
      const payeeKind = sender.relation === 'other_side' ? 'seller_solicitor' : sender.relation === 'client' ? 'client' : sender.relation === 'lender' ? 'lender' : sender.relation === 'agent' ? 'estate_agent' : 'other';
      await engine().recordBankDetails(user.tenantId, matterId, { actor: user.userId, payeeKind, payeeRef: sender.name || sender.address, details: { sortCode: bank.sortCode, accountNumber: bank.accountNumber, accountName: bank.accountName ?? sender.name ?? sender.address, firmName: null }, sourceChannel: 'email', sourceDocumentId: doc.id, note: `Found in an email from ${sender.name ? `${sender.name} <${sender.address}>` : sender.address} (${sender.relation.replace(/_/g, ' ')}). Verify by phone on a known number before any payment.` });
      proposals += 1;
    }
    return { outcome: 'noted', as: null, reason: null, proposals };
  }
  return { outcome: 'filed', as: role && role !== 'other' ? role : null, reason: report?.action.kind === 'skip' ? report.action.reason : 'the case is not enrolled' };
}

/** How the case knows an email address: its contacts' roles, or the firm's own people. Unknown otherwise. */
export async function senderRelation(tenantId: string, matterId: string, address: string): Promise<SenderRelation> {
  const email = address.toLowerCase();
  const row = await queryOne<{ role: string | null }>(`select role from matter_contact where tenant_id = $1 and matter_id = $2 and lower(email) = $3`, [tenantId, matterId, email]).catch(() => null);
  const role = row?.role ?? null;
  if (role === 'CLIENT') return 'client';
  if (role === 'AGENT') return 'agent';
  if (role === 'OTHER_SIDE') return 'other_side';
  if (role === 'LENDER') return 'lender';
  if (role === 'OUR_FIRM') return 'colleague';
  const self = await tenantSelfAddresses(tenantId).catch(() => null);
  if (self && (self.emails.has(email) || self.domains.has(email.split('@')[1] ?? ''))) return 'colleague';
  return 'unknown';
}
