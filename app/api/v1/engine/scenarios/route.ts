import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { writeAudit } from '@/lib/server/audit';
import { SCENARIOS, stepsFor } from '@/lib/server/engine/scenarios/library';
import { runScenario } from '@/lib/server/engine/scenarios/runner';
import { listSandboxMatters } from '@/lib/server/engine/sandbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The scenario library and the firm's sandbox cases. Admins only. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    return ok({
      scenarios: SCENARIOS.map((s) => ({ id: s.id, label: s.label, transactionType: s.transactionType, summary: s.summary, steps: { clean: stepsFor(s, false).map((st) => ({ id: st.id, label: st.label })), flagged: stepsFor(s, true).map((st) => ({ id: st.id, label: st.label })) } })),
      sandboxes: await listSandboxMatters(user.tenantId),
    });
  } catch (error) {
    return fail(error);
  }
}

/** Run a scenario onto a new sandbox case, stopping at a step. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const body = z.object({ scenarioId: z.string().min(1).max(60), stopAt: z.string().max(60).nullish(), flagged: z.boolean().optional(), mode: z.enum(['run', 'step']).optional() }).parse(await req.json());
    const r = await runScenario({ tenantId: user.tenantId, userId: user.userId, scenarioId: body.scenarioId, stopAt: body.stopAt ?? null, flagged: !!body.flagged, mode: body.mode ?? 'run' });
    await writeAudit({ tenantId: user.tenantId, matterId: r.matterId, actorUserId: user.userId, actionType: 'SANDBOX_SCENARIO_RUN', actionStatus: r.steps.every((s) => s.ok) ? 'SUCCESS' : 'FAILED', payload: { scenarioId: body.scenarioId, flagged: !!body.flagged, stoppedAt: r.stoppedAt, steps: r.steps.length } }).catch(() => {});
    return ok(r);
  } catch (error) {
    return fail(error);
  }
}
