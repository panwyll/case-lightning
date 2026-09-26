import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { ENGINE_ACTIONS, type EngineAction } from '@/lib/server/engine/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Trust levels (admins): each engine action's level and the record that earns a
 * promotion — how many proposals of that action people approved, and how many they
 * rejected, across the firm's cases.
 */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const svc = engine();
    const [levels, states] = await Promise.all([svc.levels(user.tenantId), svc.eventStore.listStates(user.tenantId, { includeFinished: true, limit: 5000 })]);
    const tally: Record<EngineAction, { proposed: number; approved: number; rejected: number; pending: number; failed: number }> = Object.fromEntries(ENGINE_ACTIONS.map((a) => [a, { proposed: 0, approved: 0, rejected: 0, pending: 0, failed: 0 }])) as never;
    for (const { state } of states) {
      for (const p of Object.values(state.proposals ?? {})) {
        const t = tally[p.action];
        if (!t) continue;
        t.proposed += 1;
        if (p.status === 'approved') t.approved += 1;
        else if (p.status === 'rejected') t.rejected += 1;
        else if (p.status === 'failed') { t.approved += 1; t.failed += 1; }
        else t.pending += 1;
      }
      // Held auto-clears are proposals too: approve = the clear went through.
      for (const d of Object.values(state.decisions)) {
        if (d.kind !== 'auto_clear' || !d.subject) continue;
        const held = state.pendingAutoClears?.[d.eventId] !== undefined || d.summary.includes('PROPOSE level');
        if (!held) continue;
        const t = tally.auto_clear;
        t.proposed += 1;
        if (d.status === 'pending') t.pending += 1;
        else if (d.resolution === 'approve') t.approved += 1;
        else t.rejected += 1;
      }
    }
    return ok({ levels, actions: ENGINE_ACTIONS.map((a) => ({ action: a, level: levels[a], ...tally[a] })) });
  } catch (error) {
    return fail(error);
  }
}
