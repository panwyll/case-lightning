import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { visibleMatterIds } from '@/lib/server/access';
import { engine } from '@/lib/server/engine/adapters';
import { query } from '@/lib/server/db';
import { buckets, matterWork, OWNER_LABEL, type WorkItem } from '@/lib/server/engine/work';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The personal work list (docs/caseload-ux.md §4): DO · WAITING · CHASE across this
 * person's whole caseload. Nothing here is stored — it is derived from the same state the
 * machine enforces, so it cannot drift from the cases, and nobody has to groom it.
 *
 * `all=1` (conveyancers / admins) widens it to the team's caseload for cover; `user=<id>`
 * shows one colleague's, for the same people.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const q = z.object({ all: z.string().optional(), user: z.string().uuid().optional(), limit: z.coerce.number().min(1).max(500).optional() }).parse(Object.fromEntries(req.nextUrl.searchParams));
    const cover = user.role === 'ADMIN' || user.role === 'CONVEYANCER';
    const all = q.all === '1' && cover;
    const who = q.user && (cover || q.user === user.userId) ? q.user : user.userId;
    const svc = engine();
    const [states, subflows] = await Promise.all([
      svc.eventStore.listStates(user.tenantId, { assignedTo: all ? null : who, limit: q.limit ?? 300 }),
      svc.eventStore.loadLevels(user.tenantId),
    ]);
    const now = new Date();
    const items: WorkItem[] = [];
    const visible = await visibleMatterIds(user);
    for (const { state, meta } of states) {
      if (visible && !visible.has(state.matterId)) continue;
      items.push(...matterWork(state, now, { ...meta, levels: subflows }).items);
    }
    // A state stored before waits recorded their opener: read the opening event's actor from the log.
    const missing = items.filter((i) => !i.openedBy && i.openedBySeq != null);
    if (missing.length) {
      const rows = await query<{ matter_id: string; seq: string; actor: string }>(
        `select matter_id, seq::text as seq, actor from matter_event where tenant_id = $1 and (matter_id, seq) in (select unnest($2::uuid[]), unnest($3::bigint[]))`,
        [user.tenantId, missing.map((i) => i.matterId), missing.map((i) => i.openedBySeq)]
      );
      const actor = new Map(rows.map((r) => [`${r.matter_id}:${r.seq}`, r.actor]));
      for (const i of missing) i.openedBy = actor.get(`${i.matterId}:${i.openedBySeq}`) ?? null;
    }
    // Who asked, by name: a person's id becomes their display name; the engine's own openings stay as system / ai / external.
    const ids = [...new Set(items.map((i) => i.openedBy).filter((v): v is string => !!v && /^[0-9a-f-]{36}$/i.test(v)))];
    if (ids.length) {
      const rows = await query<{ id: string; display_name: string | null; email: string | null }>(`select id, display_name, email from app_user where tenant_id = $1 and id = any($2::uuid[])`, [user.tenantId, ids]);
      const name = new Map(rows.map((r) => [r.id, r.display_name || r.email || r.id]));
      for (const i of items) if (i.openedBy && name.has(i.openedBy)) i.openedBy = name.get(i.openedBy)!;
    }
    return ok({ ...buckets(items), scope: all ? 'all' : who === user.userId ? 'mine' : 'colleague', matters: states.length, ownerLabels: OWNER_LABEL });
  } catch (error) {
    return fail(error);
  }
}
