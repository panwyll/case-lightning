/**
 * A bounce of an email CONVEYi sent from someone's mailbox: the mail server's "Undeliverable: <subject>" notice comes back
 * to that mailbox. The message it bounced is marked failed in the log, so the bounce rate (Analytics → Cases) counts it.
 */
import { query } from '../db';
import type { SessionUser } from '../types';

const NOTICE = /^\s*(undeliverable|undelivered mail returned to sender|delivery status notification \(failure\)|mail delivery failed[^:]*|returned mail[^:]*|delivery has failed[^:]*)\s*:\s*(.+)$/i;
const SERVER = /(^|[._-])(mailer-daemon|postmaster|microsoftexchange[0-9a-f]*)(@|$)/i;

/** The subject of the message that bounced, when this is a bounce notice. */
export function bouncedSubject(message: { subject?: string | null; from?: { emailAddress?: { address?: string | null } | null } | null }): string | null {
  const from = message.from?.emailAddress?.address ?? '';
  const m = NOTICE.exec(String(message.subject ?? ''));
  return m && (SERVER.test(from) || /undeliverable|delivery status/i.test(m[1])) ? m[2].trim() : null;
}

/** Marks the latest matching send of the last week failed. Returns whether one was found. */
export async function markBounced(user: SessionUser, message: Parameters<typeof bouncedSubject>[0]): Promise<boolean> {
  const subject = bouncedSubject(message);
  if (!subject) return false;
  const r = await query<{ id: string }>(
    `update client_message set status = 'FAILED: bounced' where id = (
       select id from client_message where tenant_id = $1 and direction = 'OUT' and status = 'SENT' and subject = $2 and created_at > now() - interval '7 days'
        order by created_at desc limit 1) returning id`, [user.tenantId, subject]
  );
  return r.length > 0;
}
