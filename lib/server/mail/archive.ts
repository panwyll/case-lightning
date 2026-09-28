/**
 * Keeping Outlook in step with the Email tab. A conversation filed to a case goes, read, into
 * that case's own folder under the Inbox (created in each mailbox the first time); one set aside
 * as not case email goes to Archive. When the case completes, every mailbox's folder for it moves
 * into Archive in one step. Undoing a set-aside returns the conversation to the inbox.
 * Best-effort and always after the mail is read and filed: a moved message gets a new id.
 * Governed by the firm's switch (Rules: archiveHandledEmail).
 */
import { query, queryOne } from '../db';
import { getPolicy } from '../policy';
import { ensureInboxSubfolder, moveConversation, moveMailFolder } from '../graph';

const warn = (what: string) => (e: unknown) => { console.warn(`[mail] ${what}`, (e as Error).message); return 0; };

/** "ANWYLL-KT2 · 9 Arthur Road": the reference first, then the first line of the address. */
export function caseFolderName(matterRef: string, propertyAddress: string | null): string {
  const first = (propertyAddress ?? '').split(',')[0].trim();
  return (first ? `${matterRef} · ${first}` : matterRef).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 120);
}

/** This mailbox's folder for the case, created on first use. */
async function caseFolder(tenantId: string, matterId: string, userId: string): Promise<string | null> {
  const known = await queryOne<{ folder_id: string }>(`select folder_id from matter_mail_folder where matter_id = $1 and user_id = $2`, [matterId, userId]).catch(() => null);
  if (known) return known.folder_id;
  const m = await queryOne<{ matter_ref: string; property_address: string | null }>(`select matter_ref, property_address from matter where id = $1 and tenant_id = $2`, [matterId, tenantId]);
  if (!m) return null;
  const name = caseFolderName(m.matter_ref, m.property_address);
  const id = await ensureInboxSubfolder(userId, name);
  await query(`insert into matter_mail_folder (tenant_id, matter_id, user_id, folder_id, folder_name) values ($1,$2,$3,$4,$5) on conflict (matter_id, user_id) do update set folder_id = excluded.folder_id`, [tenantId, matterId, userId, id, name]).catch(() => {});
  return id;
}

/** Filed to a case: into the case's folder, read. Set aside (no case): into Archive. */
/** `markRead`: a person filed it (they have seen it). A reply filed automatically stays unread in the case folder. */
export async function archiveHandled(tenantId: string, mailboxUserId: string, conversationId: string | null | undefined, matterId?: string | null, opts: { markRead?: boolean } = {}): Promise<number> {
  if (!conversationId) return 0;
  if (!(await getPolicy(tenantId, 'archiveHandledEmail').catch(() => true))) return 0;
  if (matterId) {
    const folder = await caseFolder(tenantId, matterId, mailboxUserId).catch(warn('could not make the case folder'));
    if (folder) return moveConversation(mailboxUserId, conversationId, 'inbox', String(folder), { markRead: opts.markRead ?? true }).catch(warn('could not file the conversation into the case folder'));
  }
  return moveConversation(mailboxUserId, conversationId, 'inbox', 'archive').catch(warn('could not archive the conversation'));
}

export async function unarchiveHandled(tenantId: string, mailboxUserId: string, conversationId: string): Promise<number> {
  if (!(await getPolicy(tenantId, 'archiveHandledEmail').catch(() => true))) return 0;
  return moveConversation(mailboxUserId, conversationId, 'archive', 'inbox').catch(warn('could not return the conversation to the inbox'));
}

/** The case completed: every mailbox's folder for it moves into Archive. */
export async function archiveCaseFolders(tenantId: string, matterId: string): Promise<number> {
  if (!(await getPolicy(tenantId, 'archiveHandledEmail').catch(() => true))) return 0;
  const rows = await query<{ user_id: string; folder_id: string }>(`select user_id, folder_id from matter_mail_folder where tenant_id = $1 and matter_id = $2 and archived_at is null`, [tenantId, matterId]).catch(() => []);
  let n = 0;
  for (const r of rows) {
    try {
      const id = await moveMailFolder(r.user_id, r.folder_id, 'archive');
      await query(`update matter_mail_folder set archived_at = now(), folder_id = $3 where matter_id = $1 and user_id = $2`, [matterId, r.user_id, id]);
      n += 1;
    } catch (e) {
      console.warn('[mail] could not archive a case folder', (e as Error).message);
    }
  }
  return n;
}
