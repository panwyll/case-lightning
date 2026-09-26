import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { stageBlockers } from '@/lib/server/engine/machine';
import { pendingDecisions, openWaits, surfacedDecisions } from '@/lib/server/engine/types';
import { queryOne } from '@/lib/server/db';
import { requireWriter, requireDecider, toCommand, userCommandSchema } from '@/lib/server/engine/http';
import { writeAudit } from '@/lib/server/audit';
import { counterpartyTypeOf } from '@/lib/server/engine/counterparty';
import { profileOf } from '@/lib/server/engine/transactions';
import { lifecycle, lifecycleFor, gatesFor, LIFECYCLE_LABEL } from '@/lib/server/engine/graph';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The engine's view of a matter: the projected state (replayed from the log on every
 * read — no cached column is trusted), what is blocking the next stage, the open
 * waits and the pending decisions. Component #6 reads this.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const svc = engine();
    const [state, subflows, matter] = await Promise.all([
      svc.getState(user.tenantId, matterId),
      svc.subflows(user.tenantId),
      queryOne<{ matter_ref: string; property_address: string; stage: string | null; shadow_mode: boolean | null; assigned_to: string | null; handler: string | null }>(
        `select m.matter_ref, m.property_address, m.stage, m.shadow_mode, m.assigned_to, coalesce(u.display_name, u.email) as handler
           from matter m left join app_user u on u.id = m.assigned_to where m.id = $1 and m.tenant_id = $2`,
        [matterId, user.tenantId]
      ).catch(() => null),
    ]);
    const profile = profileOf(state.transactionType);
    return ok({
      state,
      // The transaction profile (docs/transaction-types.md): which phases, workstreams and gates this type has — the UI draws from it.
      profile: { ...profile, lifecycle: lifecycleFor(profile), gates: gatesFor(state) },
      lifecycle: { id: lifecycle(state), label: LIFECYCLE_LABEL[lifecycle(state)] },
      blockers: stageBlockers(state),
      waits: openWaits(state),
      // Everything the log holds (the panel shows the engine's conclusions) …
      pendingDecisions: pendingDecisions(state),
      // … and what a person may act on (addendum 3 §2).
      surfacedDecisions: surfacedDecisions(state, subflows),
      subflows,
      matter: matter ? { matterRef: matter.matter_ref, propertyAddress: matter.property_address, legacyStage: matter.stage, shadowMode: !!matter.shadow_mode, assignedTo: matter.assigned_to, handler: matter.handler } : null,
    });
  } catch (error) {
    return fail(error);
  }
}

/** Issue a human command (see engine/http.ts for the allowed set). Returns the events appended. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    requireWriter(user);
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const input = userCommandSchema.parse(await req.json());
    // Addendum: the audit trail records whether the other side is walled-off internal or external.
    if (input.type === 'enrol' && input.counterpartyType == null) input.counterpartyType = await counterpartyTypeOf(user.tenantId, matterId);
    const svc = engine();
    let result;
    if (input.type === 'request_id_check') result = await svc.requestIdCheck(user.tenantId, matterId, user.userId);
    else if (input.type === 'request_proof_of_funds') result = await svc.requestProofOfFunds(user.tenantId, matterId, user.userId, { noteToClient: input.noteToClient ?? null });
    else if (input.type === 'draft_report_on_title') result = await svc.draftReportOnTitle(user.tenantId, matterId);
    else if (input.type === 'send_report_on_title') {
      requireDecider(user);
      result = await svc.sendReportOnTitle(user.tenantId, matterId, user.userId);
    } else if (input.type === 'record_bank_details') {
      result = await svc.recordBankDetails(user.tenantId, matterId, { actor: user.userId, payeeKind: input.payeeKind, payeeRef: input.payeeRef ?? null, details: { ...input.details, firmName: input.details.firmName ?? null }, sourceChannel: input.sourceChannel, sourceDocumentId: input.sourceDocumentId ?? null, note: input.note ?? null });
    } else if (input.type === 'record_note') {
      result = await svc.recordNote(user.tenantId, matterId, { text: input.text, kind: input.kind, actor: user.userId, documentId: input.documentId ?? null, durationSeconds: input.durationSeconds ?? null });
    } else if (input.type === 'set_shadow_mode') {
      if (user.role !== 'ADMIN') throw Object.assign(new Error('Only an admin switches shadow mode.'), { status: 403 });
      result = await svc.setShadowMode(user.tenantId, matterId, user.userId, input.shadowMode, input.reason ?? null);
    } else if (input.type === 'payment_authorised' || input.type === 'funds_requested') {
      requireDecider(user); // money moves only on a conveyancer's say-so
      const cmd = toCommand(input, user.userId);
      if (!cmd) throw new Error('Unsupported command.');
      result = await svc.run(user.tenantId, matterId, cmd);
    } else {
      const cmd = toCommand(input, user.userId);
      if (!cmd) throw new Error('Unsupported command.');
      result = await svc.run(user.tenantId, matterId, cmd);
    }
    await writeAudit({ tenantId: user.tenantId, matterId, actorUserId: user.userId, actionType: 'ENGINE_COMMAND', actionStatus: 'SUCCESS', payload: { command: input.type, events: result.events.map((e) => ({ seq: e.seq, type: e.type })) } }).catch(() => {});
    return ok({ events: result.events, stage: result.state.stage, blockers: stageBlockers(result.state), pendingDecisions: pendingDecisions(result.state), warning: result.warning ?? null });
  } catch (error) {
    return fail(error);
  }
}
