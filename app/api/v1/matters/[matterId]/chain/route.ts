import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { engine } from '@/lib/server/engine/adapters';
import { profileOf } from '@/lib/server/engine/transactions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The cases this one could be linked to as the client's chain: this firm's open, enrolled cases on the other side, not linked elsewhere, not exchanged. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const svc = engine();
    const here = await svc.getState(user.tenantId, matterId);
    const side = profileOf(here.transactionType ?? 'freehold_purchase').side;
    const want = side === 'buyer' ? 'seller' : side === 'seller' ? 'buyer' : null;
    if (!want) return ok({ candidates: [] });
    const rows = await query<{ id: string; matter_ref: string | null; property_address: string | null; buyer_names: string[] | null; seller_names: string[] | null }>(
      // Not the other side of this same deal (an internal counterparty is not the client's chain), and nothing this person is walled from.
      `select m.id, m.matter_ref, m.property_address, m.buyer_names, m.seller_names from matter m
        where m.tenant_id = $1 and m.id <> $2 and coalesce(m.status, 'OPEN') = 'OPEN' and coalesce(m.sandbox, false) = false
          and not exists (select 1 from matter_link l where l.tenant_id = m.tenant_id and ((l.matter_a = $2 and l.matter_b = m.id) or (l.matter_b = $2 and l.matter_a = m.id)))
          and not engine_walled(m.id)
        order by m.updated_at desc nulls last limit 200`,
      [user.tenantId, matterId]
    );
    const candidates = (await Promise.all(rows.map(async (r) => {
      const s = await svc.getState(user.tenantId, r.id).catch(() => null);
      if (!s?.enrolled || s.closedAt || s.abandoned || s.exchange.exchangedAt) return null;
      if (profileOf(s.transactionType ?? 'freehold_purchase').side !== want) return null;
      if (s.relatedMatter && s.relatedMatter.matterId !== matterId) return null;
      const client = (want === 'seller' ? r.seller_names : r.buyer_names)?.filter(Boolean).join(' & ') || null;
      return { matterId: r.id, matterRef: r.matter_ref, propertyAddress: r.property_address, client };
    }))).filter(Boolean);
    return ok({ candidates, want: want === 'seller' ? 'sale' : 'purchase' });
  } catch (error) {
    return fail(error);
  }
}
