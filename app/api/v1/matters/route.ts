import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { makeMatterFolderPath } from '@/lib/server/matter';
import { ensureMatterFolder, ensureExcelTracker } from '@/lib/server/graph';
import { matterSelfIdentifiers, upsertIdentifiers, domainOf } from '@/lib/server/matching';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const body = z
      .object({
        matterRef: z.string().min(1),
        propertyAddress: z.string().min(1),
        buyerNames: z.array(z.string()).default([]),
        sellerNames: z.array(z.string()).default([]),
        counterpartySolicitor: z.string().optional(),
        counterpartyAgent: z.string().optional(),
        exchangeTargetDate: z.string().optional(),
        completionTargetDate: z.string().optional(),
        lender: z.string().optional(),
        chainPosition: z.string().optional(),
      })
      .parse(await req.json());

    const policy = await queryOne<{ folder_naming_pattern: string }>(
      `select folder_naming_pattern from policy_config where tenant_id = $1`,
      [user.tenantId]
    );
    const folderPath = makeMatterFolderPath(body.matterRef, body.propertyAddress, policy?.folder_naming_pattern);

    const caseRefToken = body.matterRef.toUpperCase();
    const matter = await queryOne<{ id: string }>(
      `insert into matter
        (tenant_id, matter_ref, property_address, buyer_names, seller_names, counterparty_solicitor,
         counterparty_agent, exchange_target_date, completion_target_date, lender, chain_position, created_by, folder_path, case_ref_token)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [
        user.tenantId,
        body.matterRef,
        body.propertyAddress,
        body.buyerNames,
        body.sellerNames,
        body.counterpartySolicitor ?? null,
        body.counterpartyAgent ?? null,
        body.exchangeTargetDate ?? null,
        body.completionTargetDate ?? null,
        body.lender ?? null,
        body.chainPosition ?? null,
        user.userId,
        folderPath,
        caseRefToken,
      ]
    );

    // Seed matching identifiers: address postcode, party names, our case-ref token,
    // and the counterparty solicitor domain (weak signal, never decisive on its own).
    await upsertIdentifiers(user.tenantId, matter!.id, [
      ...matterSelfIdentifiers({
        property_address: body.propertyAddress,
        buyer_names: body.buyerNames,
        seller_names: body.sellerNames,
        case_ref_token: caseRefToken,
      }),
      ...(domainOf(body.counterpartySolicitor) ? [{ kind: 'DOMAIN' as const, value: domainOf(body.counterpartySolicitor)! }] : []),
    ]);

    // Provision the user-facing M365 surfaces: a OneDrive folder + a live Excel tracker.
    const folder = await ensureMatterFolder(user.userId, folderPath);
    const tracker = await ensureExcelTracker(user.userId, folderPath);

    await query(
      `update matter set drive_id = $1, folder_item_id = $2, folder_web_url = $3,
         tracker_item_id = $4, tracker_web_url = $5 where id = $6 and tenant_id = $7`,
      [
        folder.parentReference?.driveId ?? folder.parentReference?.driveId ?? null,
        folder.id ?? null,
        folder.webUrl ?? null,
        tracker.id ?? null,
        tracker.webUrl ?? null,
        matter!.id,
        user.tenantId,
      ]
    );

    await query(
      `insert into matter_summary (matter_id, tenant_id, facts, outstanding_items, risks)
       values ($1,$2,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb)`,
      [matter!.id, user.tenantId]
    );

    await writeAudit({
      tenantId: user.tenantId,
      matterId: matter!.id,
      actorUserId: user.userId,
      actionType: 'MATTER_CREATED',
      actionStatus: 'SUCCESS',
      payload: { matterRef: body.matterRef, folderPath },
    });

    return ok({ id: matter!.id, folderPath, folderWebUrl: folder.webUrl ?? null, trackerWebUrl: tracker.webUrl ?? null });
  } catch (error) {
    return fail(error);
  }
}
