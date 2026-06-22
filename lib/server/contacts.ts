/**
 * Per-matter address book. We harvest every address that appears on a matter's
 * email traffic (sender + recipients) so the assistant can later address an
 * action to the RIGHT party — e.g. "email the client an update" — rather than
 * only ever replying to whoever happened to send the last message.
 *
 * Capture is best-effort and idempotent on (matter, email): we never overwrite a
 * human-assigned role, and a name fills in the first time we learn one.
 */
import { query } from './db';

export type ContactRole = 'CLIENT' | 'OTHER_SIDE' | 'AGENT' | 'LENDER' | 'OUR_FIRM' | 'OTHER' | 'UNKNOWN';

export interface ObservedContact {
  email: string;
  name?: string | null;
  source?: string;
}

/** Pull sender + to/cc recipients off a raw Graph message into observed contacts. */
export function contactsFromGraphMessage(msg: any): ObservedContact[] {
  const out: ObservedContact[] = [];
  const push = (r: any, source: string) => {
    const email = r?.emailAddress?.address;
    if (email) out.push({ email, name: r.emailAddress.name ?? null, source });
  };
  if (msg?.from) push(msg.from, 'EMAIL_FROM');
  for (const r of msg?.toRecipients ?? []) push(r, 'EMAIL_TO');
  for (const r of msg?.ccRecipients ?? []) push(r, 'EMAIL_CC');
  return out;
}

/**
 * Upsert observed contacts for a matter. Idempotent on (matter, email): refreshes
 * last_seen and back-fills a missing name, but never touches a role the user has
 * set. Returns how many rows were touched.
 */
export async function recordMatterContacts(
  user: { tenantId: string },
  matterId: string,
  contacts: ObservedContact[]
): Promise<number> {
  let n = 0;
  for (const c of contacts) {
    const email = (c.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) continue;
    await query(
      `insert into matter_contact (tenant_id, matter_id, email, name, source, last_seen_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (matter_id, email) do update
         set name = coalesce(nullif(matter_contact.name, ''), excluded.name),
             last_seen_at = now()`,
      [user.tenantId, matterId, email, c.name ?? null, c.source ?? 'EMAIL']
    );
    n += 1;
  }
  return n;
}

/** Convenience: harvest + store every address on a Graph message. Best-effort. */
export async function recordContactsFromMessage(
  user: { tenantId: string },
  matterId: string,
  msg: any
): Promise<number> {
  return recordMatterContacts(user, matterId, contactsFromGraphMessage(msg));
}
