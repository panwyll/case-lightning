import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { ENGINE_ACTIONS, ENGINE_ACTION_LABEL, ENGINE_ACTION_SUBJECTS, levelFor, levelKey, type EngineAction } from '@/lib/server/engine/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Tally { proposed: number; approved: number; rejected: number; failed: number; pending: number }
const zero = (): Tally => ({ proposed: 0, approved: 0, rejected: 0, failed: 0, pending: 0 });

/**
 * Trust levels (admins): every action and each of its subjects, the level in force, and
 * the record that earns a promotion — proposals approved, declined, failed, waiting.
 */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const svc = engine();
    const [levels, states] = await Promise.all([svc.levels(user.tenantId), svc.eventStore.listStates(user.tenantId, { includeFinished: true, limit: 5000 })]);
    const tally = new Map<string, Tally>();
    const bump = (key: string, status: 'approved' | 'rejected' | 'failed' | 'pending') => {
      const t = tally.get(key) ?? zero();
      t.proposed += 1;
      if (status === 'failed') { t.approved += 1; t.failed += 1; } else t[status] += 1;
      tally.set(key, t);
    };
    for (const { state } of states) {
      for (const p of Object.values(state.proposals ?? {})) bump(levelKey(p.action, p.subject), p.status);
      for (const d of Object.values(state.decisions)) {
        if (d.kind !== 'auto_clear' || !d.subject || !d.summary.includes('PROPOSE level')) continue;
        const subFlow = d.subject.split(':')[0];
        bump(levelKey('auto_clear', subFlow), d.status === 'pending' ? 'pending' : d.resolution === 'approve' ? 'approved' : 'rejected');
      }
    }
    const groups = ENGINE_ACTIONS.map((action: EngineAction) => {
      const rows = ENGINE_ACTION_SUBJECTS[action].map((s) => ({
        key: levelKey(action, s.key),
        label: s.label,
        level: levelFor(levels, action, s.key),
        overridden: levels[levelKey(action, s.key)] !== undefined,
        ...(tally.get(levelKey(action, s.key)) ?? zero()),
      }));
      const sum = rows.reduce((a, r) => ({ proposed: a.proposed + r.proposed, approved: a.approved + r.approved, rejected: a.rejected + r.rejected, failed: a.failed + r.failed, pending: a.pending + r.pending }), tally.get(action) ?? zero());
      return { action, label: ENGINE_ACTION_LABEL[action], level: levelFor(levels, action), ...sum, rows };
    });
    return ok({ levels, groups });
  } catch (error) {
    return fail(error);
  }
}
