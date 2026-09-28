/**
 * Keeping the Outlook inbox in step with the Email tab: a conversation handled here (filed to a
 * case, or set aside as not case email) is archived in the mailbox it came from; putting it
 * back in the queue returns it to the inbox. Best-effort and after everything else: the mail is
 * read and filed first, because a moved message gets a new id in Outlook.
 */
import { getPolicy } from '../policy';
import { moveConversation } from '../graph';

export async function archiveHandled(tenantId: string, mailboxUserId: string, conversationId: string | null | undefined): Promise<number> {
  if (!conversationId) return 0;
  if (!(await getPolicy(tenantId, 'archiveHandledEmail').catch(() => true))) return 0;
  return moveConversation(mailboxUserId, conversationId, 'inbox', 'archive').catch((e) => {
    console.warn('[mail] could not archive the conversation', (e as Error).message);
    return 0;
  });
}

export async function unarchiveHandled(tenantId: string, mailboxUserId: string, conversationId: string): Promise<number> {
  if (!(await getPolicy(tenantId, 'archiveHandledEmail').catch(() => true))) return 0;
  return moveConversation(mailboxUserId, conversationId, 'archive', 'inbox').catch((e) => {
    console.warn('[mail] could not return the conversation to the inbox', (e as Error).message);
    return 0;
  });
}
