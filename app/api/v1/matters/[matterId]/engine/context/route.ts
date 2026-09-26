import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { queryOne } from '@/lib/server/db';
import { engine } from '@/lib/server/engine/adapters';
import { taskContext } from '@/lib/server/engine/context';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type MatterRow = { matter_ref: string; property_address: string; buyer_names: string[] | null; seller_names: string[] | null; purchase_price: string | null; lender: string | null; counterparty_solicitor: string | null; counterparty_agent: string | null; exchange_target_date: string | null; completion_target_date: string | null };

/** The context for recording one milestone by hand: what a completion sheet shows above its fields. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const q = z.object({ command: z.string().min(1).max(60), subject: z.string().max(120).nullish() }).parse({ command: req.nextUrl.searchParams.get('command'), subject: req.nextUrl.searchParams.get('subject') });
    const svc = engine();
    const [state, events, matter] = await Promise.all([
      svc.getState(user.tenantId, matterId),
      svc.listEvents(user.tenantId, matterId),
      queryOne<MatterRow>(`select matter_ref, property_address, buyer_names, seller_names, purchase_price::text, lender, counterparty_solicitor, counterparty_agent, exchange_target_date::text, completion_target_date::text from matter where id = $1 and tenant_id = $2`, [matterId, user.tenantId]),
    ]);
    const context = taskContext({
      state,
      events,
      target: { kind: 'command', type: q.command, subject: q.subject ?? null },
      matter: { matterRef: matter?.matter_ref ?? null, propertyAddress: matter?.property_address ?? null, buyerNames: matter?.buyer_names, sellerNames: matter?.seller_names, purchasePrice: matter?.purchase_price, lender: matter?.lender, counterpartySolicitor: matter?.counterparty_solicitor, counterpartyAgent: matter?.counterparty_agent, exchangeTargetDate: matter?.exchange_target_date, completionTargetDate: matter?.completion_target_date },
    });
    return ok({ context });
  } catch (error) {
    return fail(error);
  }
}
