/**
 * Unlocking a password-protected file on a case: the unlocked copy replaces the bytes we read
 * (the original stays wherever it was filed), the file is marked open, the task closes, the
 * document is read into the case, and the audit log says who unlocked it and how. The
 * password itself is used once and never stored.
 */
import { query, queryOne } from './db';
import { getBlob, putBlob } from './blob-store';
import { writeAudit } from './audit';
import { downloadDriveItem } from './graph';
import { driveUserFor } from './matter-drive';
import { engine } from './engine/adapters';
import { ingestFiledDocument } from './engine/ingest-hook';
import { isLockedPdf, unlockPdf } from './pdf-lock';
import { SYSTEM } from './engine/types';

export interface LockedDoc { id: string; matterId: string; fileName: string | null; createdAt: string }

export async function lockedDocuments(tenantId: string, matterId: string, withinHours: number | null = null): Promise<LockedDoc[]> {
  return query<{ id: string; matter_id: string; file_name: string | null; created_at: string }>(
    `select id, matter_id, file_name, created_at from document where tenant_id = $1 and matter_id = $2 and superseded_at is null and (extracted_facts->>'locked')::boolean = true${withinHours ? ` and created_at > now() - interval '${Math.floor(withinHours)} hours'` : ''} order by created_at desc`,
    [tenantId, matterId]
  ).then((rows) => rows.map((r) => ({ id: r.id, matterId: r.matter_id, fileName: r.file_name, createdAt: r.created_at })));
}

/** Mark a freshly filed PDF as locked and raise the task that asks for its password. Best effort: filing never fails on it. */
export async function recordLockedDocument(tenantId: string, matterId: string, documentId: string, fileName: string): Promise<void> {
  await query(`update document set extracted_facts = coalesce(extracted_facts, '{}'::jsonb) || '{"locked": true}'::jsonb where id = $1 and tenant_id = $2`, [documentId, tenantId]).catch(() => {});
  try {
    const svc = engine();
    const s = await svc.getState(tenantId, matterId);
    if (!s.enrolled || s.completion.confirmedAt) return;
    const title = `Password-protected file: ${fileName}`;
    if (Object.values(s.issues).some((i) => i.status === 'open' && i.title === title)) return;
    await svc.run(tenantId, matterId, { type: 'raise_issue', actor: SYSTEM, kind: 'file_locked', title, detail: `${fileName} arrived password-protected, so nothing in it can be read yet. The password usually comes separately (an email, a text, a phone call). Enter it with Enter Password on this task (or against the file on the Documents tab); a password in a later email to this case is tried automatically. [doc:${documentId}]`, gate: 'none', severity: 'warning', documentId });
  } catch { /* the file is still marked; the tab shows it */ }
}

async function bytesFor(tenantId: string, documentId: string): Promise<{ bytes: Buffer; matterId: string; fileName: string | null; hasBlob: boolean } | null> {
  const row = await queryOne<{ matter_id: string; file_name: string | null; graph_item_id: string | null; created_by: string | null; blob: Buffer | null }>(
    `select d.matter_id, d.file_name, d.graph_item_id, d.created_by, (select b.bytes from document_blob b where b.document_id = d.id) as blob from document d where d.id = $1 and d.tenant_id = $2`,
    [documentId, tenantId]
  );
  if (!row) return null;
  let bytes: Buffer | null = row.blob ?? (await getBlob(tenantId, documentId).catch(() => null));
  if (!bytes && row.graph_item_id) {
    const owner = await driveUserFor(tenantId, row.matter_id, row.created_by ?? '');
    if (owner) bytes = await downloadDriveItem(owner, row.graph_item_id).catch(() => null);
  }
  return bytes ? { bytes, matterId: row.matter_id, fileName: row.file_name, hasBlob: !!row.blob } : null;
}

/** Try a password on a locked document. Wrong password → false, nothing changes. Right password → unlocked, task closed, read into the case. */
export async function tryUnlockDocument(tenantId: string, documentId: string, password: string, by: { userId: string | null; how: string; readInBackground?: (read: Promise<unknown>) => void }): Promise<{ unlocked: boolean; reason?: string; note?: string; warning?: string }> {
  const src = await bytesFor(tenantId, documentId);
  if (!src) return { unlocked: false, reason: 'The file could not be read.' };
  // Some PDFs carry encryption only to restrict printing or copying: they open without a password.
  // Such a file was never really locked; it is marked open, its task closes and it is read, like an unlocked one.
  const needsPassword = await isLockedPdf(src.bytes);
  let open: Buffer | null = src.bytes;
  if (needsPassword) {
    // A wrong password returns null; a failure to open the file at all is a different problem, and says so.
    try { open = await unlockPdf(src.bytes, password); } catch (err) {
      console.error('[unlock] could not open the PDF to try the password', (err as Error).message);
      return { unlocked: false, reason: `The file could not be opened to try the password (${(err as Error).message.slice(0, 120)}).` };
    }
    if (!open) return { unlocked: false, reason: 'That password does not open the file.' };
    await putBlob(tenantId, documentId, open, { mime: 'application/pdf', replace: true });
  }
  const how = needsPassword ? by.how : 'no password needed';
  await query(`update document set extracted_facts = coalesce(extracted_facts, '{}'::jsonb) || $3::jsonb, size_bytes = $4 where id = $1 and tenant_id = $2`, [documentId, tenantId, JSON.stringify({ locked: false, unlockedAt: new Date().toISOString(), unlockedBy: by.userId ?? 'system', unlockedHow: how }), open.length]);
  await writeAudit({ tenantId, matterId: src.matterId, actorUserId: by.userId, actionType: 'DOCUMENT_UNLOCKED', actionStatus: 'SUCCESS', payload: { documentId, fileName: src.fileName, how } }).catch(() => {});
  // The task closes. A failure here is reported, not swallowed: an open task after a good password is exactly what a person notices.
  let warning: string | undefined;
  try {
    const svc = engine();
    const s = await svc.getState(tenantId, src.matterId);
    const issue = Object.values(s.issues).find((i) => i.kind === 'file_locked' && (i.status === 'open' || i.status === 'negotiating') && (i.detail ?? '').includes(`[doc:${documentId}]`));
    if (issue) await svc.run(tenantId, src.matterId, { type: 'resolve_issue', actor: by.userId ?? SYSTEM, issueId: issue.id, resolution: 'evidence_provided', note: needsPassword ? `Unlocked (${by.how})` : 'Opens without a password: its encryption only restricts printing or copying' });
  } catch (err) {
    console.error('[unlock] the file is open but its task could not be closed', (err as Error).message);
    warning = `The file is open, but its task could not be closed (${(err as Error).message.slice(0, 120)}). Resolve it by hand.`;
  }
  // Reading can take a while (it may call the model): the caller decides whether to wait for it.
  const read = ingestFiledDocument(tenantId, src.matterId, documentId).catch((err) => { console.error('[unlock] reading the unlocked file failed', (err as Error).message); return null; });
  if (by.readInBackground) by.readInBackground(read); else await read;
  const name = src.fileName ?? 'The file';
  return { unlocked: true, note: needsPassword ? `${name} is unlocked and is being read into the case.` : `${name} opens without a password (its encryption only restricts printing or copying). It is being read into the case.`, warning };
}

/** A message on the case may carry the password for a file that arrived recently: try each candidate, quietly. */
export async function tryPasswordsFromMessage(tenantId: string, matterId: string, text: string, candidates: string[]): Promise<string[]> {
  if (!candidates.length) return [];
  const locked = await lockedDocuments(tenantId, matterId, 72).catch(() => [] as LockedDoc[]);
  const opened: string[] = [];
  for (const doc of locked) {
    for (const pw of candidates) {
      const r = await tryUnlockDocument(tenantId, doc.id, pw, { userId: null, how: `password found in a message on the case: "${text.slice(0, 60).replace(/\s+/g, ' ')}"` }).catch(() => ({ unlocked: false }));
      if (r.unlocked) { opened.push(doc.id); break; }
    }
  }
  return opened;
}

/**
 * Files flagged as password-protected that open without one (flagged while the PDF library was
 * failing, or by an older, stricter check): each is re-checked, and one that needs no password is
 * marked open, its task closed and it is read. Bounded per run; safe to run often.
 */
export async function recheckLockedDocuments(tenantId: string | null, limit = 20, readInBackground?: (read: Promise<unknown>) => void): Promise<{ checked: number; cleared: number }> {
  const rows = await query<{ id: string; tenant_id: string }>(
    `select id, tenant_id from document where (extracted_facts->>'locked')::boolean = true and superseded_at is null${tenantId ? ' and tenant_id = $2' : ''} order by created_at desc limit $1`,
    tenantId ? [limit, tenantId] : [limit]
  ).catch(() => []);
  let cleared = 0;
  for (const r of rows) {
    const src = await bytesFor(r.tenant_id, r.id).catch(() => null);
    if (!src || (await isLockedPdf(src.bytes))) continue;
    const out = await tryUnlockDocument(r.tenant_id, r.id, '', { userId: null, how: 're-checked: no password needed', readInBackground }).catch(() => null);
    if (out?.unlocked) cleared += 1;
  }
  return { checked: rows.length, cleared };
}
