import { engineView } from '@/lib/server/engine/open-case';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { stageBlockers } from '@/lib/server/engine/machine';
import { pendingDecisions, openWaits, surfacedDecisions } from '@/lib/server/engine/types';
import { requireWriter, requireDecider, toCommand, userCommandSchema, completionSchema } from '@/lib/server/engine/http';
import { COMPLETION_CONTRACTS, type CompletionContract } from '@/lib/server/engine/completion';
import { writeAudit } from '@/lib/server/audit';
import { counterpartyTypeOf } from '@/lib/server/engine/counterparty';

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
    return ok(await engineView(svc, user.tenantId, matterId, await svc.getState(user.tenantId, matterId)));
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
    const raw = await req.json();
    const input = userCommandSchema.parse(raw);
    const completion = completionSchema.nullish().parse(raw?.completion) ?? null;
    // The document a completion cites must be this case's, and of a kind the contract accepts.
    const contract: CompletionContract | undefined = COMPLETION_CONTRACTS[input.type as keyof typeof COMPLETION_CONTRACTS];
    if (contract && completion?.documentId) {
      const doc = await engine().getDocument(user.tenantId, matterId, completion.documentId);
      if (!doc) throw Object.assign(new Error('That document is not on this case.'), { status: 400 });
      const roles = contract.documentRoles ?? [];
      const type = (doc.docType ?? '').toLowerCase();
      if (roles.length && !roles.some((r) => r.toLowerCase() === type)) throw Object.assign(new Error(`${contract.label} needs ${contract.documentLabel ?? 'a document of the right kind'}; "${doc.fileName ?? doc.id}" is filed as ${doc.docType ?? 'unknown'}.`), { status: 400 });
    }
    // Addendum: the audit trail records whether the other side is walled-off internal or external.
    if (input.type === 'enrol' && input.counterpartyType == null) input.counterpartyType = await counterpartyTypeOf(user.tenantId, matterId);
    const svc = engine();
    let result;
    if (input.type === 'request_id_check') result = await svc.requestIdCheck(user.tenantId, matterId, user.userId, input.party ?? null);
    else if (input.type === 'request_proof_of_funds') result = await svc.requestProofOfFunds(user.tenantId, matterId, user.userId, { noteToClient: input.noteToClient ?? null });
    else if (input.type === 'draft_report_on_title') result = await svc.draftReportOnTitle(user.tenantId, matterId);
    else if (input.type === 'resend_proof_of_funds') result = await svc.resendProofOfFunds(user.tenantId, matterId, user.userId);
    else if (input.type === 'retry_action') result = await svc.retryFailedAction(user.tenantId, matterId, input.proposalEventId, user.userId);
    else if (input.type === 'chase_now') result = await svc.chaseNow(user.tenantId, matterId, input.waitKey, input.subject ?? null, user.userId);
    else if (input.type === 'draft_completion_statement') {
      result = await svc.draftCompletionStatement(user.tenantId, matterId);
      await writeAudit({ tenantId: user.tenantId, matterId, actorUserId: user.userId, actionType: 'ENGINE_DRAFT', actionStatus: 'SUCCESS', payload: { kind: 'completion_statement', documentId: (result as { documentId: string }).documentId } }).catch(() => {});
    }
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
      result = await svc.run(user.tenantId, matterId, { ...cmd, completion: completion ?? {} });
    } else {
      const cmd = toCommand(input, user.userId);
      if (!cmd) throw new Error('Unsupported command.');
      result = await svc.run(user.tenantId, matterId, { ...cmd, completion: completion ?? {} });
    }
    await writeAudit({ tenantId: user.tenantId, matterId, actorUserId: user.userId, actionType: 'ENGINE_COMMAND', actionStatus: 'SUCCESS', payload: { command: input.type, events: result.events.map((e) => ({ seq: e.seq, type: e.type })) } }).catch(() => {});
    return ok({ events: result.events, stage: result.state.stage, blockers: stageBlockers(result.state), pendingDecisions: pendingDecisions(result.state), warning: result.warning ?? null });
  } catch (error) {
    return fail(error);
  }
}
