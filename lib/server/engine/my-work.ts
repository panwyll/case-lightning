import { caseHealth } from './health';
/**
 * The personal work list (docs/caseload-ux.md §4), derived from the same state the machine
 * enforces. One builder for the Tasks page and the sidebar number, so the badge is always the
 * count of what the page shows.
 */
import { engine } from './adapters';
import { visibleMatterIds } from '../access';
import { matterWork, type WorkItem } from './work';
import { profileOf } from './transactions';
import { whyNot } from './graph';
import type { SessionUser } from '../types';
import { after } from 'next/server';
import { query } from '../db';
import { syncTaskRecords, type MatterTasks } from './task-record';

const lastSync = new Map<string, number>();

export const canCover = (user: SessionUser): boolean => user.role === 'ADMIN' || user.role === 'CONVEYANCER';

/** `all`: the team's caseload (cover roles only); `who`: one person's. */
export async function workItems(user: SessionUser, opts: { all?: boolean; who?: string | null; limit?: number } = {}): Promise<{ items: WorkItem[]; matters: number }> {
  // An assistant's list is every case they may see (the visibility filter below still applies).
  const all = !!opts.all && (canCover(user) || user.role === 'ASSISTANT');
  const who = opts.who && (canCover(user) || opts.who === user.userId) ? opts.who : user.userId;
  const svc = engine();
  // One person's list is their cases, plus anything escalated to them on someone else's: so every case is read, then narrowed.
  const [states, subflows] = await Promise.all([
    svc.eventStore.listStates(user.tenantId, { assignedTo: null, limit: all ? opts.limit ?? 300 : 1000 }),
    svc.eventStore.loadLevels(user.tenantId),
  ]);
  const now = new Date();
  const items: WorkItem[] = [];
  const seen: MatterTasks[] = [];
  const visible = await visibleMatterIds(user);
  for (const { state, meta } of states) {
    if (visible && !visible.has(state.matterId)) continue;
    // The case's own colour (whose move it is), so the list's house matches the Case View.
    const caseBand = caseHealth(state, now).band;
    // An escalation belongs to whoever it was escalated to; everything else to the case's handler.
    const theirs = (i: WorkItem) => { const to = i.ref.type === 'decision' ? state.decisions[i.ref.id]?.assignedTo : null; return to ? to === who : meta.assignedTo === who; };
    const full = matterWork(state, now, { ...meta, levels: subflows }).items;
    seen.push({ matterId: state.matterId, items: full, ownerOf: (i) => (i.ref.type === 'decision' ? state.decisions[i.ref.id]?.assignedTo : null) ?? meta.assignedTo ?? null, finished: !!(state.postCompletion.ap1ConfirmedAt ?? state.abandoned?.at) });
    const list = full.filter((i) => all || theirs(i));
    items.push(...list.map((i) => ({ ...i, caseBand })));
  }
  // A case waiting on our own linked file says which file and how far it has got (its own tasks are on this list).
  const byId = new Map(states.map((x) => [x.state.matterId, x]));
  for (const i of items) {
    if (i.ref.type !== 'linked') continue;
    const other = byId.get(i.ref.id);
    if (!other) continue;
    const where = other.meta.propertyAddress ?? other.meta.matterRef ?? 'the linked case';
    // What the other file still needs before the two can exchange, in its own words ("Report on title sent: not yet").
    const left = other.state.exchange.exchangedAt ? [] : whyNot(other.state, 'exchange');
    const rel = /sale/i.test(i.chip ?? '') ? 'sale' : 'purchase';
    // Its own tasks are on this list: the count says how far off it is, not the rules' wording.
    i.what = `Exchange together with our client's ${rel} of ${where.replace(/^The client's (current|new) home,\s*/i, '')}: ${other.state.exchange.exchangedAt ? 'that has exchanged' : left.length === 0 ? `the ${rel} is ready to exchange` : `the ${rel} has ${left.length === 1 ? 'one thing' : `${left.length} things`} to clear before it can exchange`}`;
  }
  // Tasks that come and go with the clock (a deadline, a chase falling due) are caught here.
  // At most every five minutes per firm (the badge reads this list too), after the response.
  if (Date.now() - (lastSync.get(user.tenantId) ?? 0) > 5 * 60_000) {
    lastSync.set(user.tenantId, Date.now());
    const run = () => syncTaskRecords((sql, params) => query(sql, params), user.tenantId, seen).catch(() => {});
    try { after(run); } catch { void run(); }
  }
  return { items, matters: all ? states.length : states.filter((x) => x.meta.assignedTo === who).length };
}
