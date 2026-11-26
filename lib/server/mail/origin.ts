/**
 * Whether CONVEYi wrote an email in someone's mailbox: 'sent' when it sent it (stamped, or logged as one of its client
 * messages before the stamp existed), 'draft' when it wrote a draft a person then sent, null when the person wrote it.
 * CONVEYi's own email is already on the case: it is not filed again, counted as the person's work, or read for what they did.
 */
import { queryOne } from '../db';
import { conveyiOrigin } from '../graph';

export async function conveyiWrote(tenantId: string, message: any): Promise<'sent' | 'draft' | null> {
  const stamped = conveyiOrigin(message);
  if (stamped) return stamped;
  if (!message?.internetMessageId) return null;
  const logged = await queryOne<{ id: string }>(`select id from client_message where tenant_id = $1 and provider_ref = $2 limit 1`, [tenantId, message.internetMessageId]).catch(() => null);
  return logged ? 'sent' : null;
}
