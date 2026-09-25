import { query } from '../db';
import type { KnownParties } from './sender-check';

/** Who this firm deals with, for the sender checks: its own people and every case contact. */
export async function knownParties(tenantId: string): Promise<KnownParties> {
  const [contacts, people] = await Promise.all([
    query<{ email: string; name: string | null }>(`select distinct lower(email) as email, name from matter_contact where tenant_id = $1 and email not like '%@intouch.party' and email not like '%@leap.card'`, [tenantId]).catch(() => []),
    query<{ email: string; name: string | null }>(`select lower(email) as email, display_name as name from app_user where tenant_id = $1`, [tenantId]).catch(() => []),
  ]);
  const all = [...contacts, ...people];
  return { contacts: all, domains: [...new Set(all.map((c) => c.email.split('@')[1]).filter(Boolean))] };
}
