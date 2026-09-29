/**
 * task_record (migration 114): when each task appeared and when it left.
 *
 * Tasks are computed from the case, never stored, so the time one sat on a list is lost
 * unless it is written down as it happens. Two writers keep it: the event store after every
 * change to a case (exact, with the actor who cleared it), and the Tasks list when it is read
 * (catches tasks that come and go with the clock: deadlines, chases falling due).
 * Best-effort everywhere: a missing table never blocks the case.
 */
import type { WorkItem } from './work';

export type Exec = (sql: string, params: unknown[]) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const taskKey = (i: Pick<WorkItem, 'ref'>) => `${i.ref.type}:${i.ref.id}`;

export interface MatterTasks {
  matterId: string;
  items: WorkItem[];
  /** Who each item belongs to: an escalation's assignee, else the case handler. */
  ownerOf: (i: WorkItem) => string | null;
  /** The case is finished or abandoned: what leaves now left because the case closed. */
  finished?: boolean;
}

export async function syncTaskRecords(exec: Exec, tenantId: string, matters: MatterTasks[], closing: { seq?: number | null; actor?: string | null } = {}): Promise<void> {
  if (!matters.length) return;
  const m: string[] = [], id: string[] = [], bucket: string[] = [], kind: (string | null)[] = [], chip: (string | null)[] = [], title: string[] = [], owner: (string | null)[] = [];
  for (const mt of matters) {
    for (const i of mt.items) {
      m.push(mt.matterId);
      id.push(taskKey(i));
      bucket.push(i.bucket);
      kind.push(i.kind ?? null);
      chip.push(i.chip ?? null);
      title.push(i.what.slice(0, 300));
      const o = mt.ownerOf(i);
      owner.push(o && UUID.test(o) ? o : null);
    }
  }
  if (m.length) {
    await exec(
      `insert into task_record (tenant_id, matter_id, task_id, bucket, kind, chip, title, assigned_to, opened_seq)
       select $1, t.m, t.id, t.bucket, t.kind, t.chip, t.title, t.owner, $9
         from unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::uuid[]) as t(m, id, bucket, kind, chip, title, owner)
       on conflict (matter_id, task_id) where closed_at is null
       do update set bucket = excluded.bucket, assigned_to = excluded.assigned_to, title = excluded.title, chip = excluded.chip`,
      [tenantId, m, id, bucket, kind, chip, title, owner, closing.seq ?? null]
    );
  }
  // Anything open on these cases that is no longer listed has left the list.
  const live = m.map((x, n) => `${x}|${id[n]}`);
  for (const how of ['done', 'case_closed'] as const) {
    const ids = matters.filter((x) => !!x.finished === (how === 'case_closed')).map((x) => x.matterId);
    if (!ids.length) continue;
    await exec(
      `update task_record set closed_at = now(), closed_seq = $3, closed_by = $4, closed_how = $5
        where tenant_id = $1 and matter_id = any($2::uuid[]) and closed_at is null
          and not ((matter_id::text || '|' || task_id) = any($6::text[]))`,
      [tenantId, ids, closing.seq ?? null, closing.actor ?? null, how, live]
    );
  }
}
