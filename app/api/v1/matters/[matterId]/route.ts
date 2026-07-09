import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { getMatterSummary } from '@/lib/server/matter';
import { recordFigureChanges, type FigureChange } from '@/lib/server/figure-audit';
import { onStageAdvanced } from '@/lib/server/tasks';
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
        purchasePrice: z.string().optional(),
        counterpartySolicitor: z.string().optional(),
        counterpartyAgent: z.string().optional(),
        exchangeTargetDate: z.string().optional(),
        completionTargetDate: z.string().optional(),
        lender: z.string().optional(),
        chainPosition: z.string().optional(),
        status: z.string().optional(),
        assignedTo: z.string().uuid().nullable().optional(),
        stage: z
          .enum(['INSTRUCTION', 'CONTRACT_PACK', 'SEARCHES_ENQUIRIES', 'REVIEW_SIGNING', 'EXCHANGE', 'COMPLETION', 'POST_COMPLETION'])
          .optional(),
        statusFlag: z.enum(['ON_TRACK', 'NEEDS_ATTENTION', 'BLOCKED']).optional(),
        track: z.enum(['PURCHASE', 'SALE', 'REMORTGAGE']).optional(),
        notes: z.string().max(5000).optional(), // free-text case notes (matter.notes)
        reason: z.string().max(500).optional(), // optional note — the "why" for the figure history
      })
      .parse(await req.json());
    await assertMatterAccess(user, matterId);

    // Snapshot the current figures before the edit so we can log who changed what to what.
    const before = await queryOne<Record<string, any>>(`select * from matter where id = $1 and tenant_id = $2`, [
      matterId,
      user.tenantId,
    ]);

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
         stage_entered_at = case when $11::text is not null and $11::text <> stage then now() else stage_entered_at end,
         stage = coalesce($11::text, stage),
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

    // purchase_price lives in a separate, guarded statement so a deploy that lands
    // before migration 017 runs can't break the other (long-standing) field edits.
    if (body.purchasePrice !== undefined) {
      try {
        await query(`update matter set purchase_price = $1, updated_at = now() where id = $2 and tenant_id = $3`, [
          body.purchasePrice,
          matterId,
          user.tenantId,
        ]);
      } catch {
        /* column not migrated yet — ignore until 017_purchase_price.sql is applied */
      }
    }

    // Free-text case notes — guarded, pending migration 036, so it can't break the
    // long-standing field edits if it lands before the column exists.
    if (body.notes !== undefined) {
      try {
        await query(`update matter set notes = $1, updated_at = now() where id = $2 and tenant_id = $3`, [
          body.notes,
          matterId,
          user.tenantId,
        ]);
      } catch {
        /* column not migrated yet — ignore until 036_matter_notes.sql is applied */
      }
    }

    // Human-readable audit entries for what a person just changed from the board/taskpane,
    // so the case history reads "owner changed", "stage moved", etc. Best-effort.
    try {
      const events: Array<[string, string, string | null]> = [];
      if (body.stage !== undefined && body.stage !== before?.stage) {
        events.push(['STAGE_SET', `Stage → ${String(body.stage).toLowerCase().replace(/_/g, ' ')}`, 'Set manually']);
      }
      if (body.statusFlag !== undefined && body.statusFlag !== before?.status_flag) {
        events.push(['STATUS_FLAG', `Marked ${String(body.statusFlag).toLowerCase().replace(/_/g, ' ')}`, null]);
      }
      if (body.assignedTo !== undefined && (body.assignedTo ?? null) !== (before?.assigned_to ?? null)) {
        let title = 'Unassigned';
        if (body.assignedTo) {
          const u = await queryOne<{ name: string }>(
            `select coalesce(display_name, email) as name from app_user where id = $1 and tenant_id = $2`,
            [body.assignedTo, user.tenantId]
          );
          title = u?.name ? `Assigned to ${u.name}` : 'Reassigned';
        }
        events.push(['ASSIGNED', title, null]);
      }
      if (body.status !== undefined && body.status !== before?.status) {
        events.push(['STATUS', body.status === 'CLOSED' ? 'Matter completed' : body.status === 'OPEN' ? 'Reopened' : `Status: ${body.status}`, null]);
      }
      for (const [type, title, details] of events) {
        await query(
          `insert into matter_timeline_event (tenant_id, matter_id, event_at, event_type, title, details)
           values ($1,$2, now(), $3, $4, $5)`,
          [user.tenantId, matterId, type, title, details]
        );
      }
    } catch {
      /* timeline table absent or transient — non-critical */
    }

    // Proactive: a stage move means the client usually needs telling. Milestones
    // (exchange/completion) get a pre-drafted update in the ready-to-send queue; other
    // moves raise a lightweight task. Deduped + best-effort inside onStageAdvanced.
    if (body.stage !== undefined && body.stage !== before?.stage) {
      await onStageAdvanced(user, matterId, body.stage).catch(() => {});
    }

    // track (PURCHASE/SALE/REMORTGAGE) — same guarded pattern, pending migration 020.
    if (body.track !== undefined) {
      try {
        await query(`update matter set track = $1, updated_at = now() where id = $2 and tenant_id = $3`, [
          body.track,
          matterId,
          user.tenantId,
        ]);
      } catch {
        /* column not migrated yet — ignore until 020_matter_track.sql is applied */
      }
    }

    // Log every figure the caller actually changed → the House-tab history (who/when/why).
    const dstr = (v: any): string | null =>
      v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
    const changes: FigureChange[] = [];
    const track = (provided: boolean, field: string, label: string, oldValue: string | null, newValue: string | undefined) => {
      if (provided) changes.push({ field, label, oldValue, newValue: newValue ?? null });
    };
    track(body.propertyAddress !== undefined, 'property_address', 'Property Address', before?.property_address ?? null, body.propertyAddress);
    track(body.purchasePrice !== undefined, 'purchase_price', 'Purchase Price', before?.purchase_price ?? null, body.purchasePrice);
    track(body.counterpartySolicitor !== undefined, 'counterparty_solicitor', "Other Side's Solicitor", before?.counterparty_solicitor ?? null, body.counterpartySolicitor);
    track(body.counterpartyAgent !== undefined, 'counterparty_agent', 'Estate Agent', before?.counterparty_agent ?? null, body.counterpartyAgent);
    track(body.exchangeTargetDate !== undefined, 'exchange_target_date', 'Exchange Date', dstr(before?.exchange_target_date), body.exchangeTargetDate);
    track(body.completionTargetDate !== undefined, 'completion_target_date', 'Completion Date', dstr(before?.completion_target_date), body.completionTargetDate);
    track(body.lender !== undefined, 'lender', 'Lender', before?.lender ?? null, body.lender);
    track(body.chainPosition !== undefined, 'chain_position', 'Chain Position', before?.chain_position ?? null, body.chainPosition);
    track(body.status !== undefined, 'status', 'Status', before?.status ?? null, body.status);
    track(body.stage !== undefined, 'stage', 'Stage', before?.stage ?? null, body.stage);
    track(body.statusFlag !== undefined, 'status_flag', 'Status Flag', before?.status_flag ?? null, body.statusFlag);
    track(body.track !== undefined, 'track', 'Transaction Type', before?.track ?? null, body.track);
    await recordFigureChanges({
      tenantId: user.tenantId,
      matterId,
      actorUserId: user.userId,
      source: 'MANUAL',
      reason: body.reason ?? null,
      changes,
    });

    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
