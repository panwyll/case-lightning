/**
 * Filing an email to its case without anyone touching it: a reply on a conversation already on
 * the case. The same steps whichever way it was noticed (the new-mail notification, or the inbox
 * sweep catching one the notification missed): attachments filed and read, the email read (and
 * always put before a person, even when nothing is proposed), the conversation moved into the
 * case folder and left unread, the case timeline told, the text indexed, stale drafts flagged.
 */
import { archiveHandled } from './archive';
import { emitMatterEvent } from '../events';
import { describeFiling, fileEmailAttachments, fileEmailBodyAsDocument, indexEmailBodyToMatter } from '../files';
import { markMatterDraftsStale } from '../worklist';
import { queryOne } from '../db';

/**
 * Claim an email for filing: true for the first caller only. A repeated notification and the inbox
 * sweep can reach the same message at the same moment; only one files it. Before migration 110 the
 * claim cannot be recorded, and filing goes ahead as it always did.
 */
export async function claimFiling(tenantId: string, messageId: string, matterId: string | null): Promise<boolean> {
  try {
    const row = await queryOne<{ graph_message_id: string }>(`insert into mail_filing_claim (tenant_id, graph_message_id, matter_id) values ($1, $2, $3) on conflict do nothing returning graph_message_id`, [tenantId, messageId, matterId]);
    return !!row;
  } catch {
    return true;
  }
}
import type { SessionUser } from '../types';

export async function autoFileToCase(user: SessionUser, message: any, matterId: string, opts: { later?: (fn: () => Promise<unknown>) => void } = {}): Promise<void> {
  const messageId: string = message.id;
  if (!(await claimFiling(user.tenantId, messageId, matterId))) return; // already being filed by another path
  const problems: string[] = [];
  // Attachments are listed whatever hasAttachments says: Outlook sets it false when a file is marked inline.
  const filed = await fileEmailAttachments(user, matterId, messageId, message.subject).catch((e) => {
    console.error('[auto-file] attachments failed', (e as Error).message);
    problems.push(`attachments could not be filed: ${(e as Error).message}`);
    return { saved: 0, files: [] };
  });
  // The email itself is read too: a reply in the body is a reply. It always comes to a person.
  const read = await fileEmailBodyAsDocument(user, matterId, message, filed.files, { surface: true }).catch((e) => {
    console.error('[auto-file] email body read failed', (e as Error).message);
    problems.push(`the email could not be read: ${(e as Error).message}`);
    return null;
  });
  if (message.hasAttachments && !filed.files.length && !problems.length) problems.push('The email says it has attachments, but none could be listed from the mailbox');
  // Into the case folder, left unread: Outlook still shows there is something new on the case.
  const archive = () => archiveHandled(user.tenantId, user.userId, message.conversationId, matterId, { markRead: false }).then(() => {});
  if (opts.later) opts.later(archive); else await archive();
  await emitMatterEvent({ tenantId: user.tenantId, matterId, eventType: 'EMAIL_FILED', title: `Email filed: ${String(message.subject ?? '').trim() || '(no subject)'}`, details: describeFiling(read, filed.files, problems).join('\n') }).catch(() => {});
  // The text itself, so a colleague answering "any update?" sees what it said, not just that it arrived.
  await indexEmailBodyToMatter(user, matterId, message).catch((e) => console.error('[auto-file] index email body failed', (e as Error).message));
  // New information can overtake a reply sitting in Drafts: flag those (this conversation's own draft is reconsidered anyway).
  const fromWho = message.from?.emailAddress?.name || message.from?.emailAddress?.address || 'someone';
  await markMatterDraftsStale(user.tenantId, matterId, `New email from ${fromWho}${message.subject ? ` — “${String(message.subject).slice(0, 60)}”` : ''}`, `thread:${message.conversationId ?? ''}`).catch(() => 0);
}
