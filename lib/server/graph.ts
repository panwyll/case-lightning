/**
 * Microsoft Graph access for the signed-in user (delegated). Everything the
 * product touches on the user side lives here: reading the current Outlook
 * thread, creating draft-only replies, and the per-case OneDrive folder + the
 * live Excel tracker. No send endpoint exists by design.
 */
import { Client, GraphError } from '@microsoft/microsoft-graph-client';
import { queryOne, query } from './db';
import { refreshAccessToken } from './oauth';
import { config } from './config';
import { TRACKER_XLSX_BASE64, TRACKER_TABLE } from './tracker-template';

interface UserTokenRow {
  id: string;
  graph_access_token: string | null;
  graph_refresh_token: string | null;
  token_expires_at: string | null;
}

async function ensureAccessToken(userId: string): Promise<string> {
  const row = await queryOne<UserTokenRow>(
    `select id, graph_access_token, graph_refresh_token, token_expires_at from app_user where id = $1`,
    [userId]
  );
  if (!row || !row.graph_access_token) {
    throw new Error('Graph account not connected for this user');
  }

  const expires = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
  if (Date.now() + 60_000 < expires) {
    return row.graph_access_token;
  }
  if (!row.graph_refresh_token) {
    throw new Error('Refresh token missing; reconnect required');
  }

  const refreshed = await refreshAccessToken(row.graph_refresh_token);
  const newExpires = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await query(
    `update app_user set graph_access_token = $1, graph_refresh_token = $2, token_expires_at = $3 where id = $4`,
    [refreshed.access_token, refreshed.refresh_token ?? row.graph_refresh_token, newExpires, userId]
  );
  return refreshed.access_token;
}

export async function graphClientForUser(userId: string): Promise<Client> {
  const token = await ensureAccessToken(userId);
  return Client.init({ authProvider: (done) => done(null, token) });
}

function encodePath(p: string): string {
  if (p.includes('..')) throw new Error('Invalid path');
  return p.split('/').map(encodeURIComponent).join('/');
}

/**
 * Turn a thrown Graph error into a human-readable message. The SDK's GraphError
 * leaves `.message` EMPTY when Graph replies with a body-less error (e.g. a bare
 * `401` with `Content-Length: 0`, which is exactly what mailbox endpoints return
 * for an account with no accessible Exchange mailbox). Without this, such
 * failures surface to the user as a blank string. We fall back to the HTTP
 * status (and `code`/`body` when present) so the cause is never invisible.
 */
export function describeGraphError(error: unknown): string {
  if (error instanceof GraphError) {
    const detail = error.message || (typeof error.body === 'string' ? error.body : '') || error.code || '';
    const status = error.statusCode && error.statusCode > 0 ? ` (HTTP ${error.statusCode})` : '';
    if (error.statusCode === 401) {
      return `Microsoft Graph denied access to the mailbox${status}. This account has no Graph-readable Outlook/Exchange mailbox — onboarding needs a licensed mailbox it can read.`;
    }
    // OneDrive/SharePoint provisioning (matter folder + Excel tracker) fails when
    // the tenant has no SharePoint Online licence — Graph returns a 400 whose body
    // says "Tenant does not have a SPO license." Give the same actionable hint.
    if (/SPO license|SharePoint/i.test(detail)) {
      return `Couldn't provision the matter's OneDrive folder / Excel tracker${status}. This account's tenant has no SharePoint Online / OneDrive licence, which CaseLightning needs to store matter files.`;
    }
    return `Microsoft Graph request failed${status}${detail ? `: ${detail}` : '.'}`;
  }
  if (error instanceof Error) return error.message || error.name || 'Unknown error';
  return String(error) || 'Unknown error';
}

// ── Mail ──────────────────────────────────────────────────────────────────

export async function listThreadMessages(userId: string, conversationId: string): Promise<any[]> {
  const client = await graphClientForUser(userId);
  // Graph rejects $filter on conversationId combined with $orderby on a different
  // property ("The restriction or sort order is too complex"), so fetch filtered
  // and sort chronologically in memory instead.
  const result = await client
    .api('/me/messages')
    .filter(`conversationId eq '${conversationId.replace(/'/g, "''")}'`)
    .select(
      'id,subject,body,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,conversationId,internetMessageId,categories,hasAttachments'
    )
    .top(200)
    .get();
  const messages = (result.value ?? []) as any[];
  return messages.sort((a, b) => {
    const ta = new Date(a.receivedDateTime ?? a.sentDateTime ?? 0).getTime();
    const tb = new Date(b.receivedDateTime ?? b.sentDateTime ?? 0).getTime();
    return ta - tb;
  });
}

/**
 * One page of the user's mail at or after `sinceIso` (null = no lower bound),
 * spanning all folders so we capture both received and sent mail (counterparties
 * live in sent items). Pass back the returned `nextLink` to fetch the next page.
 * Light projection only — used to discover existing cases during onboarding.
 */
export async function listMailSince(
  userId: string,
  sinceIso: string | null,
  nextLink?: string | null,
  top = 100
): Promise<{ messages: any[]; nextLink: string | null }> {
  const client = await graphClientForUser(userId);
  let result: any;
  try {
    if (nextLink) {
      result = await client.api(nextLink).get();
    } else {
      let req = client
        .api('/me/messages')
        .select('id,subject,from,toRecipients,ccRecipients,conversationId,receivedDateTime,bodyPreview,hasAttachments')
        .top(top)
        .orderby('receivedDateTime desc');
      // `sinceIso` may arrive as a Date (pg parses timestamptz columns into Date
      // objects) — coerce to strict ISO 8601, which is what the OData filter needs.
      if (sinceIso) req = req.filter(`receivedDateTime ge ${new Date(sinceIso).toISOString()}`);
      result = await req.get();
    }
  } catch (error) {
    // Mailbox endpoints answer with a body-less 401 for accounts that have no
    // accessible Exchange mailbox (guest/unlicensed tenants). Re-throw with a
    // legible message so callers don't store/show an empty error string.
    throw new Error(describeGraphError(error));
  }
  return { messages: result.value ?? [], nextLink: result['@odata.nextLink'] ?? null };
}

export async function listMessageAttachments(userId: string, messageId: string): Promise<any[]> {
  const client = await graphClientForUser(userId);
  const result = await client.api(`/me/messages/${messageId}/attachments`).get();
  return result.value ?? [];
}

/** Attachment metadata only (no bytes) — used to list reviewable files cheaply. */
export async function listMessageAttachmentsMeta(userId: string, messageId: string): Promise<any[]> {
  const client = await graphClientForUser(userId);
  const result = await client
    .api(`/me/messages/${messageId}/attachments`)
    .select('id,name,contentType,size,isInline')
    .get();
  return (result.value ?? []).filter((a: any) => !a.isInline);
}

/** A single attachment WITH its bytes (contentBytes, base64) for review. */
export async function getMessageAttachment(userId: string, messageId: string, attachmentId: string): Promise<any> {
  const client = await graphClientForUser(userId);
  return client.api(`/me/messages/${messageId}/attachments/${attachmentId}`).get();
}

/** Download the raw bytes of a OneDrive item (a doc already saved to the matter). */
export async function downloadDriveItem(userId: string, itemId: string): Promise<Buffer> {
  const client = await graphClientForUser(userId);
  const stream = await client.api(`/me/drive/items/${itemId}/content`).getStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function getMessage(userId: string, messageId: string): Promise<any> {
  const client = await graphClientForUser(userId);
  return client
    .api(`/me/messages/${messageId}`)
    .select('id,subject,body,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,internetMessageId,conversationId')
    .get();
}

/**
 * Creates a draft REPLY in Outlook (via Graph createReply, so it threads with the
 * original conversation and pre-fills the right recipients) and patches in our
 * drafted body. Never sends.
 *
 * We deliberately keep Outlook's native "RE: …" subject — overwriting it with a
 * fresh subject makes Outlook treat the draft as a brand-new email rather than a
 * reply. We only append the matter's case-ref token (for matching) when given.
 */
export async function createReplyDraft(
  userId: string,
  messageId: string,
  bodyHtml: string,
  opts: { appendToken?: string } = {}
): Promise<{ id: string; subject: string; webLink: string | null }> {
  const client = await graphClientForUser(userId);

  // Reuse an existing reply draft in this conversation rather than piling up a new
  // draft every time the user re-runs the reply action. We only adopt a draft whose
  // subject is a reply ("RE: …") so we never clobber a forward/new-message draft.
  let draft: { id: string; subject?: string; webLink?: string | null } | null = null;
  try {
    const src = await client.api(`/me/messages/${messageId}`).select('conversationId').get();
    const conversationId: string | undefined = src?.conversationId;
    if (conversationId) {
      const res = await client
        .api('/me/messages')
        .filter(`conversationId eq '${conversationId.replace(/'/g, "''")}'`)
        .select('id,subject,isDraft,webLink,createdDateTime')
        .top(50)
        .get();
      const time = (m: any) => new Date(m.createdDateTime ?? 0).getTime();
      draft =
        ((res.value ?? []) as any[])
          .filter((m) => m.isDraft && /^\s*re\s*:/i.test(m.subject ?? ''))
          .sort((a, b) => time(b) - time(a))[0] ?? null;
    }
  } catch {
    // Best-effort dedup — fall through to creating a fresh reply.
  }

  const reply = draft ?? (await client.api(`/me/messages/${messageId}/createReply`).post({ comment: '' }));
  const updateBody: Record<string, unknown> = {
    body: { contentType: 'HTML', content: bodyHtml },
  };
  let subject: string = reply.subject ?? '';
  if (opts.appendToken && !subject.includes(`[#${opts.appendToken}]`)) {
    subject = `${subject} [#${opts.appendToken}]`;
    updateBody.subject = subject;
  }
  await client.api(`/me/messages/${reply.id}`).patch(updateBody);
  return { id: reply.id, subject, webLink: reply.webLink ?? null };
}

/** Add a file as an attachment to a message; uses an upload session for >3 MB. */
const ATTACH_SIMPLE_MAX = 3 * 1024 * 1024;
export async function addAttachmentToMessage(
  userId: string,
  messageId: string,
  name: string,
  bytes: Buffer,
  contentType?: string
): Promise<void> {
  const client = await graphClientForUser(userId);
  const ct = contentType || 'application/octet-stream';
  if (bytes.length <= ATTACH_SIMPLE_MAX) {
    await client.api(`/me/messages/${messageId}/attachments`).post({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name,
      contentBytes: bytes.toString('base64'),
      contentType: ct,
    });
    return;
  }
  // Large attachment → chunked upload session.
  const session = await client.api(`/me/messages/${messageId}/attachments/createUploadSession`).post({
    AttachmentItem: { attachmentType: 'file', name, size: bytes.length, contentType: ct },
  });
  const uploadUrl = session.uploadUrl as string;
  const CHUNK = 4 * 1024 * 1024;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    const slice = bytes.subarray(start, end);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}` },
      body: new Uint8Array(slice),
    });
    if (!res.ok && res.status !== 200 && res.status !== 201) {
      throw new Error(`Attachment upload failed (HTTP ${res.status}).`);
    }
  }
}

/**
 * Attach a OneDrive file to a reply on a thread. If a draft reply already exists
 * in the conversation it's reused; otherwise a reply is created to the most recent
 * message. Returns the draft's webLink and whether an existing draft was reused.
 */
export async function attachFileToThreadReply(
  userId: string,
  conversationId: string,
  fileItemId: string,
  fileName: string,
  contentType?: string | null
): Promise<{ webLink: string | null; reused: boolean }> {
  const client = await graphClientForUser(userId);
  const res = await client
    .api('/me/messages')
    .filter(`conversationId eq '${conversationId.replace(/'/g, "''")}'`)
    .select('id,isDraft,receivedDateTime,sentDateTime,webLink')
    .top(200)
    .get();
  const msgs = (res.value ?? []) as any[];
  const time = (m: any) => new Date(m.receivedDateTime ?? m.sentDateTime ?? 0).getTime();
  const draft = msgs.filter((m) => m.isDraft).sort((a, b) => time(b) - time(a))[0];
  const latest = msgs.filter((m) => !m.isDraft).sort((a, b) => time(b) - time(a))[0];

  let draftId: string;
  let webLink: string | null;
  let reused = false;
  if (draft) {
    draftId = draft.id;
    webLink = draft.webLink ?? null;
    reused = true;
  } else {
    if (!latest) throw new Error('There’s no email in this thread to reply to.');
    const created = await client.api(`/me/messages/${latest.id}/createReply`).post({ comment: '' });
    draftId = created.id;
    webLink = created.webLink ?? null;
  }

  const bytes = await downloadDriveItem(userId, fileItemId);
  await addAttachmentToMessage(userId, draftId, fileName, bytes, contentType ?? undefined);
  return { webLink, reused };
}

/**
 * Creates a draft FORWARD of a message to a colleague (via Graph createForward, so
 * the original thread is carried along) with an optional instruction comment.
 * Used by Delegate. Never sends.
 */
export async function createForwardDraft(
  userId: string,
  messageId: string,
  toEmail: string,
  comment = ''
): Promise<{ id: string; subject: string; webLink: string | null }> {
  const client = await graphClientForUser(userId);
  const draft = await client.api(`/me/messages/${messageId}/createForward`).post({
    comment,
    toRecipients: [{ emailAddress: { address: toEmail } }],
  });
  return { id: draft.id, subject: draft.subject ?? '', webLink: draft.webLink ?? null };
}

/** Creates a standalone draft email (not a reply) — draft-only, never sent. */
export async function createDraftMessage(
  userId: string,
  subject: string,
  bodyHtml: string,
  toRecipients: string[] = []
): Promise<any> {
  const client = await graphClientForUser(userId);
  return client.api('/me/messages').post({
    subject,
    body: { contentType: 'HTML', content: bodyHtml },
    toRecipients: toRecipients.filter(Boolean).map((address) => ({ emailAddress: { address } })),
  });
}

export async function setMessageCategory(userId: string, messageId: string, category: string): Promise<void> {
  const client = await graphClientForUser(userId);
  await client.api(`/me/messages/${messageId}`).patch({ categories: [category] });
}

// ── Per-matter mail folders ──────────────────────────────────────────────────

/**
 * Ensures an Inbox subfolder with the given display name exists, returning its id.
 * Idempotent: reuses an existing child folder of the same name rather than making
 * a duplicate. Used to give each matter its own Inbox subfolder.
 */
export async function ensureInboxSubfolder(userId: string, displayName: string): Promise<string> {
  const client = await graphClientForUser(userId);
  const existing = await client
    .api(`/me/mailFolders/inbox/childFolders`)
    .top(200)
    .select('id,displayName')
    .get();
  const match = (existing.value ?? []).find((f: any) => f.displayName === displayName);
  if (match) return match.id;
  const created = await client.api(`/me/mailFolders/inbox/childFolders`).post({ displayName });
  return created.id;
}

/**
 * Moves a message into a folder. Returns the moved message's NEW id (Graph assigns
 * a fresh id on move). Categories travel with the message. Best-effort caller.
 */
export async function moveMessageToFolder(userId: string, messageId: string, destinationId: string): Promise<string> {
  const client = await graphClientForUser(userId);
  const moved = await client.api(`/me/messages/${messageId}/move`).post({ destinationId });
  return moved?.id ?? messageId;
}

// ── Outlook category tags ────────────────────────────────────────────────────

// A small palette of Graph category colour presets we cycle through.
const CATEGORY_COLORS = ['preset0', 'preset5', 'preset8', 'preset3', 'preset10', 'preset6'];

/**
 * Ensures a named Outlook category exists in the user's master list (coloured).
 * Pass an explicit Graph preset (e.g. 'preset0' = red) to pin the colour;
 * otherwise a stable colour is derived from the name so a given matter/label
 * always shows the same colour in the message list.
 */
export async function ensureMasterCategory(userId: string, displayName: string, color?: string): Promise<void> {
  const client = await graphClientForUser(userId);
  const chosen = color ?? CATEGORY_COLORS[Math.abs(hash(displayName)) % CATEGORY_COLORS.length];
  const findByName = async () =>
    ((await client.api('/me/outlook/masterCategories').get()).value ?? []).find(
      (c: any) => c.displayName === displayName
    );
  // Pin the colour on an existing category if it's drifted (e.g. it was created
  // colourless by Outlook auto-creating it on a message patch, or by an older build).
  const pin = async (cat: { id: string; color?: string }) => {
    if (cat.color !== chosen) await client.api(`/me/outlook/masterCategories/${cat.id}`).patch({ color: chosen });
  };
  try {
    const found = await findByName();
    if (found) {
      await pin(found);
      return;
    }
    try {
      await client.api('/me/outlook/masterCategories').post({ displayName, color: chosen });
    } catch {
      // Race: a concurrent triage (or Outlook auto-creating it from a message
      // patch) made the category first — usually colourless. Re-fetch and pin
      // the colour so it doesn't stay grey.
      const made = await findByName();
      if (made) await pin(made);
    }
  } catch {
    /* category APIs can fail on some mailbox types — tagging is best-effort */
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Adds categories to a message, merging with any already present (no clobber). */
export async function addMessageCategories(userId: string, messageId: string, toAdd: string[]): Promise<void> {
  const client = await graphClientForUser(userId);
  const msg = await client.api(`/me/messages/${messageId}`).select('categories').get();
  const merged = Array.from(new Set([...(msg.categories ?? []), ...toAdd]));
  await client.api(`/me/messages/${messageId}`).patch({ categories: merged });
}

// ── Change-notification subscriptions (auto-triage on arrival) ────────────────

export async function createInboxSubscription(
  userId: string,
  notificationUrl: string,
  clientState: string,
  expiresAt: string
): Promise<{ id: string; resource: string; expirationDateTime: string }> {
  const client = await graphClientForUser(userId);
  return client.api('/subscriptions').post({
    changeType: 'created',
    notificationUrl,
    resource: "/me/mailFolders('inbox')/messages",
    expirationDateTime: expiresAt,
    clientState,
  });
}

export async function renewSubscription(userId: string, subscriptionId: string, expiresAt: string): Promise<void> {
  const client = await graphClientForUser(userId);
  await client.api(`/subscriptions/${subscriptionId}`).patch({ expirationDateTime: expiresAt });
}

export async function deleteSubscription(userId: string, subscriptionId: string): Promise<void> {
  const client = await graphClientForUser(userId);
  await client.api(`/subscriptions/${subscriptionId}`).delete();
}

/**
 * Creates a reply draft, sets its body, and SENDS it. This is the only code path
 * that sends mail and is reachable ONLY through an enabled, risk-accepted SEND
 * auto-rule (and the tenant kill-switches) — never from the interactive flow.
 */
export async function createAndSendReply(
  userId: string,
  messageId: string,
  bodyHtml: string
): Promise<string> {
  const draft = await createReplyDraft(userId, messageId, bodyHtml);
  const client = await graphClientForUser(userId);
  await client.api(`/me/messages/${draft.id}/send`).post({});
  return draft.id;
}

// ── OneDrive (per-case knowledge base) ──────────────────────────────────────

/** Ensures the matter folder exists under the OneDrive root; returns the driveItem. */
export async function ensureMatterFolder(userId: string, folderPath: string): Promise<any> {
  const client = await graphClientForUser(userId);
  try {
    return await client.api(`/me/drive/root:/${encodePath(folderPath)}`).get();
  } catch {
    // Create the (possibly nested) folder under its parent.
    const parts = folderPath.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/');
    const parentEndpoint = parentPath
      ? `/me/drive/root:/${encodePath(parentPath)}:/children`
      : '/me/drive/root/children';
    return client.api(parentEndpoint).post({
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'replace',
    });
  }
}

export async function uploadToMatterFolder(
  userId: string,
  folderPath: string,
  fileName: string,
  content: Buffer | ArrayBuffer
): Promise<any> {
  const client = await graphClientForUser(userId);
  const endpoint = `/me/drive/root:/${encodePath(`${folderPath}/${fileName}`)}:/content`;
  return client.api(endpoint).put(content);
}

export async function listMatterFiles(userId: string, folderPath: string): Promise<any[]> {
  const client = await graphClientForUser(userId);
  const result = await client.api(`/me/drive/root:/${encodePath(folderPath)}:/children`).get();
  return result.value ?? [];
}

// ── Excel case tracker ──────────────────────────────────────────────────────

export interface TrackerRow {
  date: string;
  type: string;
  detail: string;
  owner: string;
  due: string;
  status: string;
}

/** Uploads (creates or overwrites) a file at a OneDrive path; returns the driveItem. */
export async function putDriveFile(userId: string, path: string, content: Buffer): Promise<any> {
  const client = await graphClientForUser(userId);
  return client.api(`/me/drive/root:/${encodePath(path)}:/content`).put(content);
}

/** Gets a file's driveItem (incl. webUrl) by path, or null if it doesn't exist. */
export async function getDriveItemByPath(userId: string, path: string): Promise<any | null> {
  const client = await graphClientForUser(userId);
  try {
    return await client.api(`/me/drive/root:/${encodePath(path)}`).get();
  } catch {
    return null;
  }
}

/** Deletes a file by OneDrive path. Returns true if it existed and was removed. */
export async function deleteDriveItemByPath(userId: string, path: string): Promise<boolean> {
  const client = await graphClientForUser(userId);
  try {
    await client.api(`/me/drive/root:/${encodePath(path)}`).delete();
    return true;
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode === 404) return false;
    throw error;
  }
}

/** Downloads a file's bytes by OneDrive path, or null if it doesn't exist yet. */
export async function getDriveFileByPath(userId: string, path: string): Promise<Buffer | null> {
  const client = await graphClientForUser(userId);
  try {
    const stream = await client.api(`/me/drive/root:/${encodePath(path)}:/content`).getStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch {
    return null; // not found yet (first build) or unreadable — caller treats as "no edits"
  }
}

/**
 * Ensures Tracker.xlsx exists in the matter folder, seeded from a template that
 * already contains the "TrackerTable" table. Returns the driveItem (id + webUrl).
 */
export async function ensureExcelTracker(userId: string, folderPath: string): Promise<any> {
  const client = await graphClientForUser(userId);
  const path = `${folderPath}/Tracker.xlsx`;
  try {
    return await client.api(`/me/drive/root:/${encodePath(path)}`).get();
  } catch {
    const buffer = Buffer.from(TRACKER_XLSX_BASE64, 'base64');
    return client.api(`/me/drive/root:/${encodePath(path)}:/content`).put(buffer);
  }
}

/** Appends a row to the tracker's table. itemId is the workbook's driveItem id. */
export async function appendTrackerRow(userId: string, itemId: string, row: TrackerRow): Promise<void> {
  const client = await graphClientForUser(userId);
  await client.api(`/me/drive/items/${itemId}/workbook/tables/${TRACKER_TABLE}/rows`).post({
    values: [[row.date, row.type, row.detail, row.owner, row.due, row.status]],
  });
}

// ── Two-way task sync ("Jira in Excel") ─────────────────────────────────────
// The tracker is a live, hand-editable surface, so we address rows by a stable
// "Ref" cell rather than by position, and map values by HEADER NAME (not column
// order) — that way a legacy 6-column tracker and an upgraded 7-column one both
// work, and a column reordered by the user doesn't corrupt writes.

export interface TrackerTaskRow {
  ref: string;
  date?: string;
  type?: string;
  detail?: string;
  owner?: string;
  due?: string;
  status?: string;
}

const norm = (s: string) => s.trim().toLowerCase();

async function trackerColumnNames(client: Client, itemId: string): Promise<string[]> {
  const res = await client.api(`/me/drive/items/${itemId}/workbook/tables/${TRACKER_TABLE}/columns`).get();
  return ((res.value ?? []) as any[]).sort((a, b) => a.index - b.index).map((c) => c.name as string);
}

function valuesForColumns(cols: string[], r: TrackerTaskRow): string[] {
  const byField: Record<string, string> = {
    ref: r.ref ?? '',
    date: r.date ?? '',
    type: r.type ?? '',
    detail: r.detail ?? '',
    owner: r.owner ?? '',
    due: r.due ?? '',
    status: r.status ?? '',
  };
  return cols.map((c) => byField[norm(c)] ?? '');
}

/** Adds the "Ref" key column to the tracker table if it isn't there yet. */
export async function ensureTrackerRefColumn(userId: string, itemId: string): Promise<void> {
  const client = await graphClientForUser(userId);
  const cols = await trackerColumnNames(client, itemId);
  if (!cols.some((c) => norm(c) === 'ref')) {
    await client.api(`/me/drive/items/${itemId}/workbook/tables/${TRACKER_TABLE}/columns`).post({ name: 'Ref' });
  }
}

/** Reads every tracker row, mapped by header — used to reconcile hand edits back. */
export async function listTrackerRows(userId: string, itemId: string): Promise<Array<TrackerTaskRow & { rowIndex: number }>> {
  const client = await graphClientForUser(userId);
  const cols = (await trackerColumnNames(client, itemId)).map(norm);
  const res = await client.api(`/me/drive/items/${itemId}/workbook/tables/${TRACKER_TABLE}/rows`).get();
  const at = (vals: any[], name: string) => {
    const i = cols.indexOf(name);
    return i >= 0 ? String(vals[i] ?? '') : '';
  };
  return ((res.value ?? []) as any[]).map((row) => {
    const vals = (row.values?.[0] ?? []) as any[];
    return {
      rowIndex: row.index as number,
      ref: at(vals, 'ref'),
      date: at(vals, 'date'),
      type: at(vals, 'type'),
      detail: at(vals, 'detail'),
      owner: at(vals, 'owner'),
      due: at(vals, 'due'),
      status: at(vals, 'status'),
    };
  });
}

/**
 * Upserts a tracker row keyed by `ref`: patches the matching row, else appends.
 *
 * The whole ensure-column → list → patch/append runs inside ONE workbook session
 * so the row index we read is the index we write — without the session, a row
 * inserted/deleted (by another writer or a human editing the sheet) between the
 * list and the patch would shift indices and we'd overwrite the wrong row. The
 * caller also serialises these per matter (see tasks.ts), so app writers can't
 * collide; the session closes the remaining window against live human edits.
 */
export async function upsertTrackerRowByRef(userId: string, itemId: string, r: TrackerTaskRow): Promise<void> {
  const client = await graphClientForUser(userId);
  const wb = `/me/drive/items/${itemId}/workbook`;
  const session = await client.api(`${wb}/createSession`).post({ persistChanges: true });
  const sid = session.id as string;
  try {
    const colsRes = await client.api(`${wb}/tables/${TRACKER_TABLE}/columns`).header('workbook-session-id', sid).get();
    let names = ((colsRes.value ?? []) as any[]).sort((a, b) => a.index - b.index).map((c) => c.name as string);
    if (!names.some((n) => norm(n) === 'ref')) {
      await client.api(`${wb}/tables/${TRACKER_TABLE}/columns`).header('workbook-session-id', sid).post({ name: 'Ref' });
      names = [...names, 'Ref'];
    }
    const values = valuesForColumns(names, r);
    const refIdx = names.map(norm).indexOf('ref');
    const rowsRes = await client.api(`${wb}/tables/${TRACKER_TABLE}/rows`).header('workbook-session-id', sid).get();
    const match = ((rowsRes.value ?? []) as any[]).find((row) => String((row.values?.[0] ?? [])[refIdx] ?? '') === r.ref);
    if (match) {
      await client.api(`${wb}/tables/${TRACKER_TABLE}/rows/itemAt(index=${match.index})`).header('workbook-session-id', sid).patch({ values: [values] });
    } else {
      await client.api(`${wb}/tables/${TRACKER_TABLE}/rows`).header('workbook-session-id', sid).post({ values: [values] });
    }
  } finally {
    await client.api(`${wb}/closeSession`).header('workbook-session-id', sid).post({}).catch(() => {});
  }
}

// ── Generic workbook table (the master board updates rows in place, live) ────

/** Reads every row of a named table, mapped by header — works while the file is open. */
/** The table's column names, in order — used to detect a stale board schema. */
export async function getTableColumns(userId: string, itemId: string, table: string): Promise<string[]> {
  const client = await graphClientForUser(userId);
  const res = await client.api(`/me/drive/items/${itemId}/workbook/tables/${table}/columns`).get();
  return ((res.value ?? []) as any[]).sort((a, b) => a.index - b.index).map((c) => c.name as string);
}

export async function listTableRows(
  userId: string,
  itemId: string,
  table: string
): Promise<Array<{ rowIndex: number; cells: Record<string, string> }>> {
  const client = await graphClientForUser(userId);
  const wb = `/me/drive/items/${itemId}/workbook`;
  const colsRes = await client.api(`${wb}/tables/${table}/columns`).get();
  const names = ((colsRes.value ?? []) as any[]).sort((a, b) => a.index - b.index).map((c) => c.name as string);
  const rowsRes = await client.api(`${wb}/tables/${table}/rows`).get();
  return ((rowsRes.value ?? []) as any[]).map((row) => {
    const vals = (row.values?.[0] ?? []) as any[];
    const cells: Record<string, string> = {};
    names.forEach((n, i) => (cells[n] = String(vals[i] ?? '')));
    return { rowIndex: row.index as number, cells };
  });
}

/**
 * Upserts many rows into a named table in ONE workbook session, keyed by a
 * column. Updating table rows via the workbook API co-authors with an open file
 * (no 423), so the board updates live while someone has it open.
 */
export async function upsertTableRowsByKey(
  userId: string,
  itemId: string,
  table: string,
  keyColumn: string,
  items: Array<{ key: string; values: Record<string, string | number> }>
): Promise<void> {
  if (!items.length) return;
  const client = await graphClientForUser(userId);
  const wb = `/me/drive/items/${itemId}/workbook`;
  const session = await client.api(`${wb}/createSession`).post({ persistChanges: true });
  const sid = session.id as string;
  const h = (req: any) => req.header('workbook-session-id', sid);
  try {
    const colsRes = await h(client.api(`${wb}/tables/${table}/columns`)).get();
    const names = ((colsRes.value ?? []) as any[]).sort((a, b) => a.index - b.index).map((c) => c.name as string);
    const keyIdx = names.findIndex((n) => norm(n) === norm(keyColumn));
    const rowsRes = await h(client.api(`${wb}/tables/${table}/rows`)).get();
    const indexByKey = new Map<string, number>();
    for (const row of (rowsRes.value ?? []) as any[]) {
      indexByKey.set(String((row.values?.[0] ?? [])[keyIdx] ?? ''), row.index as number);
    }
    for (const it of items) {
      const valuesArr = names.map((n) => (it.values[n] === undefined ? '' : it.values[n]));
      const idx = indexByKey.get(it.key);
      if (idx !== undefined) {
        await h(client.api(`${wb}/tables/${table}/rows/itemAt(index=${idx})`)).patch({ values: [valuesArr] });
      } else {
        await h(client.api(`${wb}/tables/${table}/rows`)).post({ values: [valuesArr] });
      }
    }
  } finally {
    await h(client.api(`${wb}/closeSession`)).post({}).catch(() => {});
  }
}

/** Sets the fill colour of individual cells, in one session (co-authors live). */
export async function setRangeFills(
  userId: string,
  sheet: string,
  itemId: string,
  fills: Array<{ address: string; argb: string }>
): Promise<void> {
  if (!fills.length) return;
  const client = await graphClientForUser(userId);
  const wb = `/me/drive/items/${itemId}/workbook`;
  const session = await client.api(`${wb}/createSession`).post({ persistChanges: true });
  const sid = session.id as string;
  const h = (req: any) => req.header('workbook-session-id', sid);
  try {
    for (const f of fills) {
      const hex = `#${f.argb.slice(-6)}`; // 'FFD7F0E1' → '#D7F0E1'
      await h(client.api(`${wb}/worksheets('${sheet}')/range(address='${f.address}')/format/fill`)).patch({ color: hex });
    }
  } finally {
    await h(client.api(`${wb}/closeSession`)).post({}).catch(() => {});
  }
}

// ── Teams ───────────────────────────────────────────────────────────────────

export async function postTeamsSummary(
  userId: string,
  teamId: string,
  channelId: string,
  html: string
): Promise<any> {
  const client = await graphClientForUser(userId);
  return client.api(`/teams/${teamId}/channels/${channelId}/messages`).post({
    body: { contentType: 'html', content: html },
  });
}
