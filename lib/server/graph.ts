/**
 * Microsoft Graph access for the signed-in user (delegated). Everything the
 * product touches on the user side lives here: reading the current Outlook
 * thread, creating draft-only replies, and the per-case OneDrive folder + the
 * live Excel tracker. No send endpoint exists by design.
 */
import { Client } from '@microsoft/microsoft-graph-client';
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

// ── Mail ──────────────────────────────────────────────────────────────────

export async function listThreadMessages(userId: string, conversationId: string): Promise<any[]> {
  const client = await graphClientForUser(userId);
  const result = await client
    .api('/me/messages')
    .filter(`conversationId eq '${conversationId.replace(/'/g, "''")}'`)
    .select(
      'id,subject,body,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,conversationId,internetMessageId,categories,hasAttachments'
    )
    .top(200)
    .orderby('receivedDateTime asc')
    .get();
  return result.value ?? [];
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
  nextLink?: string | null
): Promise<{ messages: any[]; nextLink: string | null }> {
  const client = await graphClientForUser(userId);
  let result: any;
  if (nextLink) {
    result = await client.api(nextLink).get();
  } else {
    let req = client
      .api('/me/messages')
      .select('id,subject,from,toRecipients,ccRecipients,conversationId,receivedDateTime,bodyPreview,hasAttachments')
      .top(50)
      .orderby('receivedDateTime desc');
    if (sinceIso) req = req.filter(`receivedDateTime ge ${sinceIso}`);
    result = await req.get();
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

/** Creates a draft reply in Outlook and patches its body/subject. Never sends. */
export async function createReplyDraft(
  userId: string,
  messageId: string,
  bodyHtml: string,
  subject?: string
): Promise<any> {
  const client = await graphClientForUser(userId);
  const draft = await client.api(`/me/messages/${messageId}/createReply`).post({ comment: '' });
  const updateBody: Record<string, unknown> = {
    body: { contentType: 'HTML', content: bodyHtml },
  };
  if (subject) updateBody.subject = subject;
  await client.api(`/me/messages/${draft.id}`).patch(updateBody);
  return draft;
}

export async function setMessageCategory(userId: string, messageId: string, category: string): Promise<void> {
  const client = await graphClientForUser(userId);
  await client.api(`/me/messages/${messageId}`).patch({ categories: [category] });
}

// ── Outlook category tags ────────────────────────────────────────────────────

// A small palette of Graph category colour presets we cycle through.
const CATEGORY_COLORS = ['preset0', 'preset5', 'preset8', 'preset3', 'preset10', 'preset6'];

/** Ensures a named Outlook category exists in the user's master list (coloured). */
export async function ensureMasterCategory(userId: string, displayName: string): Promise<void> {
  const client = await graphClientForUser(userId);
  try {
    const existing = await client.api('/me/outlook/masterCategories').get();
    if ((existing.value ?? []).some((c: any) => c.displayName === displayName)) return;
    const color = CATEGORY_COLORS[Math.abs(hash(displayName)) % CATEGORY_COLORS.length];
    await client.api('/me/outlook/masterCategories').post({ displayName, color });
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
  bodyHtml: string,
  subject?: string
): Promise<string> {
  const draft = await createReplyDraft(userId, messageId, bodyHtml, subject);
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
