/**
 * The cases a client's chain can be linked to: this firm's open, enrolled cases on the given side,
 * not linked elsewhere, not exchanged, never the other side of the same deal (an internal
 * counterparty) and never one the person is walled from.
 */
import { query } from './db';
import { engine } from './engine/adapters';
import { profileOf } from './engine/transactions';
import type { SessionUser } from './types';

export interface ChainCandidate { matterId: string; matterRef: string | null; propertyAddress: string | null; client: string | null }

export async function chainCandidates(user: SessionUser, want: 'buyer' | 'seller', forMatterId: string | null = null): Promise<ChainCandidate[]> {
  const rows = await query<{ id: string; matter_ref: string | null; property_address: string | null; buyer_names: string[] | null; seller_names: string[] | null }>(
    `select m.id, m.matter_ref, m.property_address, m.buyer_names, m.seller_names from matter m
      where m.tenant_id = $1 and ($2::uuid is null or m.id <> $2) and coalesce(m.status, 'OPEN') = 'OPEN' and coalesce(m.sandbox, false) = false
        and ($2::uuid is null or not exists (select 1 from matter_link l where l.tenant_id = m.tenant_id and ((l.matter_a = $2 and l.matter_b = m.id) or (l.matter_b = $2 and l.matter_a = m.id))))
        and not engine_walled(m.id)
      order by m.updated_at desc nulls last limit 200`,
    [user.tenantId, forMatterId]
  );
  const svc = engine();
  const out = await Promise.all(rows.map(async (r) => {
    const s = await svc.getState(user.tenantId, r.id).catch(() => null);
    if (!s?.enrolled || s.closedAt || s.abandoned || s.exchange.exchangedAt) return null;
    if (profileOf(s.transactionType ?? 'freehold_purchase').side !== want) return null;
    if (s.relatedMatter && s.relatedMatter.matterId !== forMatterId) return null;
    const client = (want === 'seller' ? r.seller_names : r.buyer_names)?.filter(Boolean).join(' & ') || null;
    return { matterId: r.id, matterRef: r.matter_ref, propertyAddress: r.property_address, client };
  }));
  return out.filter((x): x is ChainCandidate => !!x);
}
