/**
 * The cases a client's chain can be linked to: this firm's open, enrolled cases on the given side,
 * not linked elsewhere, not exchanged, never the other side of the same deal (an internal
 * counterparty) and never one the person is walled from. A sandbox case links only to sandbox
 * cases, a real one only to real ones. Cases for the same client (a name or an email in common)
 * come first, marked, so the right one is found without scrolling a list of every address.
 */
import { query, queryOne } from './db';
import { engine } from './engine/adapters';
import { profileOf } from './engine/transactions';
import type { SessionUser } from './types';

export interface ChainCandidate { matterId: string; matterRef: string | null; propertyAddress: string | null; client: string | null; sameClient: boolean }

const words = (n: string) => n.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
/** Two names for the same person: the same surname and the same first name (or initial). */
function samePerson(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.length || !y.length || x[x.length - 1] !== y[y.length - 1]) return false;
  return x.length === 1 || y.length === 1 || x[0] === y[0] || x[0][0] === y[0][0];
}
/** "Hannah & Josh Reid" is two people. */
const people = (names: string[]): string[] => names.flatMap((n) => {
  const parts = n.split(/\s+(?:&|and)\s+/i).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return [n];
  const surname = parts[parts.length - 1].split(/\s+/).slice(1).join(' ');
  return parts.map((x) => (surname && !/\s/.test(x) ? `${x} ${surname}` : x));
});

export async function chainCandidates(user: SessionUser, want: 'buyer' | 'seller', forMatterId: string | null = null, client: { names?: string[]; emails?: string[]; sandbox?: boolean } = {}): Promise<ChainCandidate[]> {
  // Who the client is, from the case itself when there is one.
  let names = client.names ?? [];
  let emails = (client.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  let sandbox = !!client.sandbox;
  if (forMatterId) {
    const me = await queryOne<{ buyer_names: string[] | null; seller_names: string[] | null; transaction_type: string | null; sandbox: boolean | null }>(`select buyer_names, seller_names, transaction_type, sandbox from matter where id = $1 and tenant_id = $2`, [forMatterId, user.tenantId]);
    sandbox = !!me?.sandbox;
    names = [...names, ...((/_sale$/.test(me?.transaction_type ?? '') ? me?.seller_names : me?.buyer_names) ?? [])];
    const cs = await query<{ email: string }>(`select lower(email) as email from matter_contact where matter_id = $1 and tenant_id = $2 and role = 'CLIENT' and email is not null`, [forMatterId, user.tenantId]).catch(() => []);
    emails = [...emails, ...cs.map((c) => c.email)];
  }
  names = people(names.filter(Boolean));
  const rows = await query<{ id: string; matter_ref: string | null; property_address: string | null; buyer_names: string[] | null; seller_names: string[] | null; client_emails: string[] | null }>(
    `select m.id, m.matter_ref, m.property_address, m.buyer_names, m.seller_names,
            (select array_agg(lower(c.email)) from matter_contact c where c.matter_id = m.id and c.tenant_id = m.tenant_id and c.role = 'CLIENT' and c.email is not null) as client_emails
       from matter m
      where m.tenant_id = $1 and ($2::uuid is null or m.id <> $2) and coalesce(m.status, 'OPEN') = 'OPEN' and coalesce(m.sandbox, false) = $3
        and ($2::uuid is null or not exists (select 1 from matter_link l where l.tenant_id = m.tenant_id and ((l.matter_a = $2 and l.matter_b = m.id) or (l.matter_b = $2 and l.matter_a = m.id))))
        and not engine_walled(m.id)
      order by m.updated_at desc nulls last limit 300`,
    [user.tenantId, forMatterId, sandbox]
  );
  const svc = engine();
  const out = await Promise.all(rows.map(async (r) => {
    const s = await svc.getState(user.tenantId, r.id).catch(() => null);
    if (!s?.enrolled || s.closedAt || s.abandoned || s.exchange.exchangedAt) return null;
    if (profileOf(s.transactionType ?? 'freehold_purchase').side !== want) return null;
    if (s.relatedMatter && s.relatedMatter.matterId !== forMatterId) return null;
    const theirs = people((want === 'seller' ? r.seller_names : r.buyer_names)?.filter(Boolean) ?? []);
    const sameClient = (r.client_emails ?? []).some((e) => emails.includes(e)) || theirs.some((t) => names.some((n) => samePerson(t, n)));
    return { matterId: r.id, matterRef: r.matter_ref, propertyAddress: r.property_address, client: theirs.join(' & ') || null, sameClient };
  }));
  return out.filter((x): x is ChainCandidate => !!x).sort((a, b) => Number(b.sameClient) - Number(a.sameClient));
}
