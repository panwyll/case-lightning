import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { getMatterSummary } from '@/lib/server/matter';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ matterId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const result = await getMatterSummary(matterId, user.tenantId);
    if (!result) return fail(new Error('Not found'));
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const body = z
      .object({
        propertyAddress: z.string().optional(),
        counterpartySolicitor: z.string().optional(),
        counterpartyAgent: z.string().optional(),
        exchangeTargetDate: z.string().optional(),
        completionTargetDate: z.string().optional(),
        lender: z.string().optional(),
        chainPosition: z.string().optional(),
        status: z.string().optional(),
        assignedTo: z.string().uuid().nullable().optional(),
        stage: z.enum(['INSTRUCTION', 'CONTRACT_PACK', 'SEARCHES_ENQUIRIES', 'REVIEW_SIGNING', 'EXCHANGE', 'COMPLETION']).optional(),
        statusFlag: z.enum(['ON_TRACK', 'NEEDS_ATTENTION', 'BLOCKED']).optional(),
      })
      .parse(await req.json());
    await assertMatterAccess(user, matterId);

    await query(
      `update matter set
         property_address = coalesce($1, property_address),
         counterparty_solicitor = coalesce($2, counterparty_solicitor),
         counterparty_agent = coalesce($3, counterparty_agent),
         exchange_target_date = coalesce($4::date, exchange_target_date),
         completion_target_date = coalesce($5::date, completion_target_date),
         lender = coalesce($6, lender),
         chain_position = coalesce($7, chain_position),
         status = coalesce($8, status),
         assigned_to = case when $9::boolean then $10::uuid else assigned_to end,
         stage = coalesce($11, stage),
         status_flag = coalesce($12, status_flag),
         updated_at = now()
       where id = $13 and tenant_id = $14`,
      [
        body.propertyAddress ?? null,
        body.counterpartySolicitor ?? null,
        body.counterpartyAgent ?? null,
        body.exchangeTargetDate ?? null,
        body.completionTargetDate ?? null,
        body.lender ?? null,
        body.chainPosition ?? null,
        body.status ?? null,
        body.assignedTo !== undefined,
        body.assignedTo ?? null,
        body.stage ?? null,
        body.statusFlag ?? null,
        matterId,
        user.tenantId,
      ]
    );
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
