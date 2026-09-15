import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { stageBlockers } from '@/lib/server/engine/machine';
import { pendingDecisions, openWaits } from '@/lib/server/engine/types';
import { requireWriter, requireDecider, toCommand, userCommandSchema } from '@/lib/server/engine/http';
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
    const state = await engine().getState(user.tenantId, matterId);
    return ok({ state, blockers: stageBlockers(state), waits: openWaits(state), pendingDecisions: pendingDecisions(state) });
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
    else if (input.type === 'draft_report_on_title') result = await svc.draftReportOnTitle(user.tenantId, matterId);
    else if (input.type === 'send_report_on_title') {
      requireDecider(user);
      result = await svc.sendReportOnTitle(user.tenantId, matterId, user.userId);
    } else {
      const cmd = toCommand(input, user.userId);
      if (!cmd) throw new Error('Unsupported command.');
      result = await svc.run(user.tenantId, matterId, cmd);
    }
    await writeAudit({ tenantId: user.tenantId, matterId, actorUserId: user.userId, actionType: 'ENGINE_COMMAND', actionStatus: 'SUCCESS', payload: { command: input.type, events: result.events.map((e) => ({ seq: e.seq, type: e.type })) } }).catch(() => {});
    return ok({ events: result.events, stage: result.state.stage, blockers: stageBlockers(result.state), pendingDecisions: pendingDecisions(result.state) });
  } catch (error) {
    return fail(error);
  }
}
