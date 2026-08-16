/**
 * Per-matter address book. We harvest every address that appears on a matter's
 * email traffic (sender + recipients) so the assistant can later address an
 * action to the RIGHT party — e.g. "email the client an update" — rather than
 * only ever replying to whoever happened to send the last message.
 *
 * Capture is best-effort and idempotent on (matter, email): we never overwrite a
 * human-assigned role, and a name fills in the first time we learn one.
 */
import { query, queryOne } from './db';
import { extractFirmRef } from './matching';

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

/**
 * Learn and store the firm's OWN matter reference from a message on a linked matter.
 *
 * Conveyancers put "Our ref: ABC/1234" on everything they send, and the other side
 * quotes it back as "Your ref: ABC/1234". Reading it here means matching and the
 * audit trail can use the reference the firm's case management system allocated —
 * so their file and ours reconcile — without integrating with that system at all.
 *
 * Written once and then left alone: the first reference seen on a matter wins, so a
 * later email quoting some other firm's reference can't overwrite it. Best-effort
 * throughout; a failure here must never disturb the analysis.
 */
export async function learnFirmRef(
  user: { tenantId: string },
  matterId: string,
  msg: any
): Promise<string | null> {
  const text = `${msg?.subject ?? ''}\n${msg?.body?.content ?? msg?.bodyPreview ?? ''}`;
  if (!text.trim()) return null;
  // sentDateTime with no receivedDateTime, or an explicit flag, marks our own mail.
  // Graph gives both on most messages, so fall back to treating it as inbound —
  // the conservative choice, since "your ref" on inbound really is ours.
  const outbound = Boolean(msg?.isDraft) || (!!msg?.sentDateTime && !msg?.receivedDateTime);
  const ref = extractFirmRef(text, { outbound });
  if (!ref) return null;
  try {
    const row = await queryOne<{ firm_ref: string | null }>(
      `update matter set firm_ref = $3
         where id = $1 and tenant_id = $2 and (firm_ref is null or firm_ref = '')
       returning firm_ref`,
      [matterId, user.tenantId, ref]
    );
    return row?.firm_ref ?? null;
  } catch {
    return null; // firm_ref column not migrated yet
  }
}
