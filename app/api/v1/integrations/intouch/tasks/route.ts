import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { inTouchClient, inTouchConnection } from '@/lib/server/integrations/intouch/adapters';
import { TASK_STEPS, taskForStep } from '@/lib/server/integrations/intouch/task-steps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Task Mapping (Tools → InTouch): each CONVEYi step, the firm's own InTouch task names (read from its five most recently
 * synced cases), what each step would complete by its name, and the firm's mapping. Read-only; saved through /writeback.
 */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const conn = await inTouchConnection(user.tenantId);
    if (conn?.status !== 'CONNECTED') return ok({ connected: false, steps: [], names: [] });
    const cases = await query<{ intouch_case_id: string }>(
      `select intouch_case_id from matter where tenant_id = $1 and intouch_case_id is not null order by intouch_synced_at desc nulls last limit 5`, [user.tenantId]
    );
    const api = await inTouchClient(user.tenantId);
    const names = new Set<string>();
    for (const c of cases) for (const t of await api.tasks(c.intouch_case_id).catch(() => [])) if (t.name?.trim()) names.add(t.name.trim());
    const all = [...names].sort((a, b) => a.localeCompare(b));
    // What each step would complete by the words alone, against an open copy of every task.
    const open = all.map((name, i) => ({ id: String(i), name, completed: false }));
    return ok({
      connected: true,
      names: all,
      map: conn.taskMap ?? {},
      steps: TASK_STEPS.map((s) => ({ key: s.key, label: s.label, byName: taskForStep(s, open)?.name ?? null })),
    });
  } catch (e) {
    return fail(e);
  }
}
