/**
 * EPA, live (docs/epa.md §2): the timed actions the Time page measures, recorded as they happen, so the live page sees
 * green the way the onboarding measurement does (measure.ts). Three sources, all into epa_action (migration 127):
 *
 * - each email a person sends, classified as it is sent off the Sent Items subscription (mail/incoming.ts), on the
 *   classify model, the same categories as the scan;
 * - what the firm filed in InTouch, read once a day by the InTouch sync: documents and notes on the cases that changed,
 *   credited to the case's fee earner;
 * - InTouch tasks completed, from its Task State Change webhook; a task's name is read as a kind of work once per firm.
 *
 * Each is best-effort: a failure here never stops mail processing, the sync or the webhook.
 */
import { query, queryOne, runAsSystem } from '../db';
import { classifyTaskKinds, classifyWorkload } from '../ai';
import { tenantSelfAddresses } from '../matching';
import type { SessionUser } from '../types';
import type { InTouchApi, InTouchHttpClient } from '../integrations/intouch/client';
import { stage } from '../workload/scan';
import { IN_CATEGORIES, IN_SPEC, OUT_CATEGORIES, OUT_SPEC, ROLES, domainOf, firmDomainsOf } from '../workload/taxonomy';
import { EPA_KINDS, EPA_SPEC, fromInTouchItem, kindFromName, type EpaKind } from './taxonomy';

/** What the live side reads from InTouch. */
type Api = Pick<InTouchApi, 'listCases' | 'getCase' | 'tasks'> & Pick<InTouchHttpClient, 'folderActivity'>;

/** The most cases a daily InTouch read looks at, and the furthest back it catches up. */
export const DAILY_CASES = 200;
const CATCH_UP_MS = 7 * 86_400_000;

/** An email the person just sent: what it was for and who it went to, kept as a timed action. */
export async function recordSent(user: SessionUser, message: any): Promise<boolean> {
  const self = await tenantSelfAddresses(user.tenantId);
  const s = stage(message, 'out', firmDomainsOf([...self.domains, domainOf(user.email)]));
  // Automated, bulk or empty mail is not work; email to colleagues is not counted.
  if (!s || s.filtered || s.internal) return false;
  const outDefs = OUT_CATEGORIES.filter((c) => c !== 'internal').map((key) => ({ key, what: OUT_SPEC[key].what }));
  const inDefs = IN_CATEGORIES.map((key) => ({ key, what: IN_SPEC[key].what }));
  const r = await classifyWorkload({
    userId: user.userId, tenantId: user.tenantId, outCategories: outDefs, inCategories: inDefs, roles: ROLES,
    emails: [{ id: 'm1', direction: 'out', subject: s.subject.slice(0, 200), people: s.people.slice(0, 300), isReply: s.isReply, isForward: s.isForward, hasAttachments: s.hasAttachments, text: s.text.slice(0, 900) }],
  });
  const x = r.results.find((y) => y.id === 'm1');
  if (!x || !(OUT_CATEGORIES as readonly string[]).includes(x.category)) return false;
  const roles = (x.roles ?? []).filter((role) => (ROLES as readonly string[]).includes(role));
  await query(
    `insert into epa_action (tenant_id, user_id, source, ref, at, drafted_at, category, roles, classified_by) values ($1,$2,'sent',$3,$4,$5,$6,$7,$8) on conflict (user_id, source, ref) do nothing`,
    [user.tenantId, user.userId, s.id, s.sentAt, s.draftedAt, x.category, roles, r.model]
  );
  return true;
}

type Person = { id: string; email: string | null; display_name: string | null };
const norm = (x: string | null | undefined) => (x ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** The firm's user a fee earner is: by email, else by a name only one person has (as the InTouch sync maps them). */
export function personFor(people: Person[], fe: { email: string | null; name: string | null } | null): string | null {
  if (!fe) return null;
  const byEmail = fe.email ? people.find((p) => norm(p.email) === norm(fe.email)) : null;
  if (byEmail) return byEmail.id;
  const named = fe.name ? people.filter((p) => norm(p.display_name) === norm(fe.name)) : [];
  return named.length === 1 ? named[0].id : null;
}

/**
 * Once a day: what the firm filed in InTouch since the last read, on the cases that changed (at most DAILY_CASES, at
 * most a week back), each document or note a timed action of its fee earner.
 */
export async function readInTouchActivity(tenantId: string, api: Api, now = new Date()): Promise<{ cases: number; recorded: number }> {
  const conn = await runAsSystem(() => queryOne<{ activity_since: Date | null }>(`select activity_since from intouch_connection where tenant_id = $1`, [tenantId]));
  const floor = now.getTime() - CATCH_UP_MS;
  const since = new Date(Math.max(floor, conn?.activity_since ? conn.activity_since.getTime() : now.getTime() - 2 * 86_400_000)).toISOString();
  const people = await runAsSystem(() => query<Person>(`select id, email, display_name from app_user where tenant_id = $1`, [tenantId]));
  const cases: Array<{ id: string; userId: string }> = [];
  let cursor: string | null = '1';
  for (let n = 0; cursor && n < 10 && cases.length < DAILY_CASES; n++) {
    const page: Awaited<ReturnType<Api['listCases']>> = await api.listCases({ cursor, updatedSince: since, limit: 100 });
    for (const c of page.items) {
      const userId = personFor(people, c.feeEarner);
      if (userId && cases.length < DAILY_CASES) cases.push({ id: c.id, userId });
    }
    cursor = page.next;
  }
  let recorded = 0;
  for (const c of cases) {
    const items = await api.folderActivity(c.id, since);
    for (const i of items) {
      if (!i.at || i.byFirm === false || i.at < since) continue;
      const kind = fromInTouchItem(i);
      if (!kind) continue;
      const name = (i.name ?? '').slice(0, 120) || null;
      const ref = `${c.id}:${i.kind}:${i.at}:${name ?? ''}`.slice(0, 300);
      const r = await runAsSystem(() => query<{ id: string }>(
        `insert into epa_action (tenant_id, user_id, source, ref, at, kind, name, case_id, classified_by) values ($1,$2,'intouch_file',$3,$4,$5,$6,$7,'rule') on conflict (user_id, source, ref) do nothing returning id`,
        [tenantId, c.userId, ref, i.at, kind, name, c.id]
      ));
      recorded += r.length;
    }
  }
  await runAsSystem(() => query(`update intouch_connection set activity_since = $2 where tenant_id = $1`, [tenantId, now]));
  return { cases: cases.length, recorded };
}

/** The kinds a task can be: everything counted. */
const TASK_KINDS = EPA_KINDS.filter((k) => EPA_SPEC[k].rag !== 'none');

/** What kind of work completing a task with this name is: the firm's earlier answer, its name, else the model once. */
export async function taskKind(tenantId: string, name: string, userId: string): Promise<EpaKind> {
  const key = name.trim().slice(0, 200);
  const known = await runAsSystem(() => queryOne<{ kind: string }>(`select kind from epa_task_kind where tenant_id = $1 and name = $2`, [tenantId, key]));
  if (known && (TASK_KINDS as readonly string[]).includes(known.kind)) return known.kind as EpaKind;
  let kind: EpaKind | null = kindFromName(key);
  if (!kind) {
    const r = await classifyTaskKinds({ userId, tenantId, names: [key], kinds: TASK_KINDS.map((k) => ({ key: k, label: EPA_SPEC[k].label, what: EPA_SPEC[k].what })) }).catch(() => []);
    kind = (r[0]?.kind as EpaKind | undefined) ?? null;
  }
  // The model failing is not an answer: not kept, so the next completion asks again.
  if (!kind) return 'filing';
  await runAsSystem(() => query(`insert into epa_task_kind (tenant_id, name, kind) values ($1,$2,$3) on conflict (tenant_id, name) do nothing`, [tenantId, key, kind]));
  return kind;
}

/**
 * An InTouch task changed state: if it is now complete, a timed action of whoever completed it (the person InTouch
 * says triggered it, else the case's fee earner), when InTouch says it happened.
 */
export async function recordInTouchTask(tenantId: string, api: Api, event: { caseId: string | null; resourceId: string | null; triggeredByEmail: string | null; occurredAt: string | null; receivedAt: string }): Promise<boolean> {
  if (!event.caseId || !event.resourceId) return false;
  const task = (await api.tasks(event.caseId)).find((t) => t.id === event.resourceId);
  if (!task?.completed || !task.name) return false;
  const people = await runAsSystem(() => query<Person>(`select id, email, display_name from app_user where tenant_id = $1`, [tenantId]));
  let userId = personFor(people, event.triggeredByEmail ? { email: event.triggeredByEmail, name: null } : null);
  if (!userId) userId = personFor(people, (await api.getCase(event.caseId))?.feeEarner ?? null);
  if (!userId) return false;
  const kind = await taskKind(tenantId, task.name, userId);
  const r = await runAsSystem(() => query<{ id: string }>(
    `insert into epa_action (tenant_id, user_id, source, ref, at, kind, name, case_id, classified_by) values ($1,$2,'intouch_task',$3,$4,$5,$6,$7,'task') on conflict (user_id, source, ref) do nothing returning id`,
    [tenantId, userId, `${event.caseId}:${task.id}`, event.occurredAt ?? event.receivedAt, kind, task.name.slice(0, 200), event.caseId]
  ));
  return r.length > 0;
}
