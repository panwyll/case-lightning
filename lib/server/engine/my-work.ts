/**
 * The personal work list (docs/caseload-ux.md §4), derived from the same state the machine
 * enforces. One builder for the Tasks page and the sidebar number, so the badge is always the
 * count of what the page shows.
 */
import { engine } from './adapters';
import { visibleMatterIds } from '../access';
import { matterWork, type WorkItem } from './work';
import type { SessionUser } from '../types';

export const canCover = (user: SessionUser): boolean => user.role === 'ADMIN' || user.role === 'CONVEYANCER';

/** `all`: the team's caseload (cover roles only); `who`: one person's. */
export async function workItems(user: SessionUser, opts: { all?: boolean; who?: string | null; limit?: number } = {}): Promise<{ items: WorkItem[]; matters: number }> {
  // An assistant's list is every case they may see (the visibility filter below still applies).
  const all = !!opts.all && (canCover(user) || user.role === 'ASSISTANT');
  const who = opts.who && (canCover(user) || opts.who === user.userId) ? opts.who : user.userId;
  const svc = engine();
  const [states, subflows] = await Promise.all([
    svc.eventStore.listStates(user.tenantId, { assignedTo: all ? null : who, limit: opts.limit ?? 300 }),
    svc.eventStore.loadLevels(user.tenantId),
  ]);
  const now = new Date();
  const items: WorkItem[] = [];
  const visible = await visibleMatterIds(user);
  for (const { state, meta } of states) {
    if (visible && !visible.has(state.matterId)) continue;
    items.push(...matterWork(state, now, { ...meta, levels: subflows }).items);
  }
  return { items, matters: states.length };
}
