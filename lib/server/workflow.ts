/**
 * Stage-triggered task workflow — the DAG an admin builds in the UI (task_template + edges).
 * When a matter reaches a stage (checkpoint), that stage's templates are instantiated as
 * matter_task rows and assigned (by role → resolved to a person, or a specific user). A template
 * with an unfinished prerequisite lands BLOCKED and unblocks when its prerequisite task is DONE.
 *
 * Self-contained (no import of tasks.ts) so tasks.ts can call in from onStageAdvanced/updateTask
 * without an import cycle. Everything is best-effort/guarded so a deploy before migration 039
 * simply behaves as "no workflow configured".
 */
import { query, queryOne, transaction } from './db';
import { createDraftMessage, sendDraftMessage } from './graph';
import { buildMatterVars } from './doc-templates';
import { addDraftReady } from './worklist';
import type { SessionUser } from './types';

export interface TaskTemplate {
  id: string;
  stage: string;
  detail: string;
  type: string;
  node_kind: 'TASK' | 'EMAIL';
  email_template_id: string | null;
  send_mode: 'DRAFT' | 'SEND' | null;
  assignee_kind: 'ROLE' | 'USER';
  assignee_role: string | null;
  assignee_user_id: string | null;
  due_offset_days: number | null;
  pos_x: number;
  pos_y: number;
  sort_order: number;
  active: boolean;
}
export interface TaskEdge {
  from_template_id: string;
  to_template_id: string;
}

const TPL_BASE = 'id, stage, detail, type, assignee_kind, assignee_role, assignee_user_id, due_offset_days, pos_x, pos_y, sort_order, active';
const TPL_COLS = `${TPL_BASE}, node_kind, email_template_id, send_mode`;
export interface EmailTemplateLite { id: string; name: string; subject_template: string | null }

// ── Default conveyancing workflow (seeded once; the firm edits from here) ──────────
// Laid out left→right by stage; y stacks tasks within a stage. Assigned to the matter
// owner by default — the admin re-points the admin-heavy ones (searches, SDLT, registration)
// at an assistant. Deps encode the natural order (review after request, exchange after signing…).
const DEFAULT_TASKS: Array<{ key: string; stage: string; detail: string; col: number; row: number }> = [
  { key: 'ins_care', stage: 'INSTRUCTION', detail: 'Issue client care letter & fee estimate', col: 0, row: 0 },
  { key: 'ins_id', stage: 'INSTRUCTION', detail: 'Complete ID verification & AML checks', col: 0, row: 1 },
  { key: 'ins_funds', stage: 'INSTRUCTION', detail: 'Confirm source of funds', col: 0, row: 2 },
  { key: 'cp_request', stage: 'CONTRACT_PACK', detail: "Request contract pack from seller's solicitor", col: 1, row: 0 },
  { key: 'cp_review', stage: 'CONTRACT_PACK', detail: 'Review contract pack (contract, TA6, TA10, title)', col: 1, row: 1 },
  { key: 'se_order', stage: 'SEARCHES_ENQUIRIES', detail: 'Order property searches (local, drainage & water, environmental)', col: 2, row: 0 },
  { key: 'se_enquiries', stage: 'SEARCHES_ENQUIRIES', detail: "Raise pre-contract enquiries with seller's solicitor", col: 2, row: 1 },
  { key: 'se_review', stage: 'SEARCHES_ENQUIRIES', detail: 'Review search results & replies to enquiries', col: 2, row: 2 },
  { key: 'se_report', stage: 'SEARCHES_ENQUIRIES', detail: 'Report to client on searches, title & enquiries', col: 2, row: 3 },
  { key: 'rs_mortgage', stage: 'REVIEW_SIGNING', detail: 'Check mortgage offer & conditions', col: 3, row: 0 },
  { key: 'rs_send', stage: 'REVIEW_SIGNING', detail: 'Send contract & report to client for signature', col: 3, row: 1 },
  { key: 'rs_signed', stage: 'REVIEW_SIGNING', detail: 'Obtain signed contract & deposit funds', col: 3, row: 2 },
  { key: 'ex_date', stage: 'EXCHANGE', detail: 'Agree completion date with all parties', col: 4, row: 0 },
  { key: 'ex_exchange', stage: 'EXCHANGE', detail: 'Exchange contracts', col: 4, row: 1 },
  { key: 'co_statement', stage: 'COMPLETION', detail: 'Prepare completion statement & request funds from client', col: 5, row: 0 },
  { key: 'co_funds', stage: 'COMPLETION', detail: 'Request mortgage advance from lender', col: 5, row: 1 },
  { key: 'co_complete', stage: 'COMPLETION', detail: 'Complete the transaction', col: 5, row: 2 },
  { key: 'pc_sdlt', stage: 'POST_COMPLETION', detail: 'Submit SDLT return & pay tax', col: 6, row: 0 },
  { key: 'pc_register', stage: 'POST_COMPLETION', detail: 'Register title & charge at HM Land Registry', col: 6, row: 1 },
  { key: 'pc_letter', stage: 'POST_COMPLETION', detail: 'Send completion letter & title info to client', col: 6, row: 2 },
];
const DEFAULT_DEPS: Array<[string, string]> = [
  ['cp_request', 'cp_review'],
  ['se_order', 'se_review'],
  ['se_enquiries', 'se_review'],
  ['se_review', 'se_report'],
  ['cp_review', 'rs_send'],
  ['se_report', 'rs_send'],
  ['rs_send', 'rs_signed'],
  ['rs_signed', 'ex_exchange'],
  ['ex_date', 'ex_exchange'],
  ['rs_mortgage', 'ex_exchange'],
  ['ex_exchange', 'co_complete'],
  ['co_statement', 'co_complete'],
  ['co_funds', 'co_complete'],
  ['co_complete', 'pc_sdlt'],
  ['pc_sdlt', 'pc_register'],
  ['co_complete', 'pc_letter'],
];

/** Seed the default conveyancing workflow the first time (or on an explicit reload). */
export async function ensureDefaultWorkflow(tenantId: string, force = false): Promise<void> {
  try {
    if (!force) {
      const t = await queryOne<{ workflow_seeded: boolean }>(`select workflow_seeded from tenant where id = $1`, [tenantId]).catch(() => null);
      if (t?.workflow_seeded) return;
      const existing = await queryOne<{ n: number }>(`select count(*)::int as n from task_template where tenant_id = $1`, [tenantId]).catch(() => ({ n: 0 }));
      if ((existing?.n ?? 0) > 0) {
        await query(`update tenant set workflow_seeded = true where id = $1`, [tenantId]).catch(() => {});
        return;
      }
    }
    const idByKey: Record<string, string> = {};
    let order = 0;
    for (const t of DEFAULT_TASKS) {
      const row = await queryOne<{ id: string }>(
        `insert into task_template (tenant_id, stage, detail, assignee_kind, assignee_role, pos_x, pos_y, sort_order)
         values ($1,$2,$3,'ROLE','OWNER',$4,$5,$6) returning id`,
        [tenantId, t.stage, t.detail, 40 + t.col * 230, 40 + t.row * 96, order++]
      );
      if (row) idByKey[t.key] = row.id;
    }
    for (const [from, to] of DEFAULT_DEPS) {
      if (idByKey[from] && idByKey[to]) {
        await query(
          `insert into task_template_edge (tenant_id, from_template_id, to_template_id)
           values ($1,$2,$3) on conflict (from_template_id, to_template_id) do nothing`,
          [tenantId, idByKey[from], idByKey[to]]
        ).catch(() => {});
      }
    }
    await query(`update tenant set workflow_seeded = true where id = $1`, [tenantId]).catch(() => {});
  } catch {
    /* best-effort — the tab still works empty if seeding can't run */
  }
}

export async function getWorkflow(
  tenantId: string
): Promise<{ templates: TaskTemplate[]; edges: TaskEdge[]; emailTemplates: EmailTemplateLite[] }> {
  let templates: TaskTemplate[] = [];
  let edges: TaskEdge[] = [];
  let emailTemplates: EmailTemplateLite[] = [];
  try {
    try {
      templates = await query<TaskTemplate>(`select ${TPL_COLS} from task_template where tenant_id = $1 order by sort_order, created_at`, [tenantId]);
    } catch {
      // Pre-migration 043 — email columns absent; read the base set and default them.
      const base = await query<TaskTemplate>(`select ${TPL_BASE} from task_template where tenant_id = $1 order by sort_order, created_at`, [tenantId]);
      templates = base.map((t) => ({ ...t, node_kind: 'TASK', email_template_id: null, send_mode: null }));
    }
    edges = await query<TaskEdge>(`select from_template_id, to_template_id from task_template_edge where tenant_id = $1`, [tenantId]);
  } catch {
    return { templates: [], edges: [], emailTemplates: [] }; // not migrated (039) yet
  }
  try {
    emailTemplates = await query<EmailTemplateLite>(`select id, name, subject_template from template where tenant_id = $1 and is_active = true order by name`, [tenantId]);
  } catch {
    /* template table always exists — ignore */
  }
  return { templates, edges, emailTemplates };
}

async function fetchTemplate(tenantId: string, id: string): Promise<TaskTemplate> {
  try {
    return (await queryOne<TaskTemplate>(`select ${TPL_COLS} from task_template where id=$1 and tenant_id=$2`, [id, tenantId]))!;
  } catch {
    const b = (await queryOne<TaskTemplate>(`select ${TPL_BASE} from task_template where id=$1 and tenant_id=$2`, [id, tenantId]))!;
    return { ...b, node_kind: 'TASK', email_template_id: null, send_mode: null };
  }
}

export async function saveTemplate(
  user: SessionUser,
  input: {
    id?: string | null;
    stage: string;
    detail: string;
    type?: string;
    nodeKind?: 'TASK' | 'EMAIL';
    emailTemplateId?: string | null;
    sendMode?: 'DRAFT' | 'SEND' | null;
    assigneeKind: 'ROLE' | 'USER';
    assigneeRole?: string | null;
    assigneeUserId?: string | null;
    dueOffsetDays?: number | null;
    posX?: number;
    posY?: number;
    sortOrder?: number;
    active?: boolean;
  }
): Promise<TaskTemplate> {
  const vals = [
    user.tenantId,
    input.stage,
    input.detail,
    input.type ?? 'TASK',
    input.assigneeKind,
    input.assigneeKind === 'ROLE' ? input.assigneeRole ?? null : null,
    input.assigneeKind === 'USER' ? input.assigneeUserId ?? null : null,
    input.dueOffsetDays ?? null,
    input.posX ?? 0,
    input.posY ?? 0,
    input.sortOrder ?? 0,
    input.active ?? true,
  ];
  let id: string;
  if (input.id) {
    await query(
      `update task_template set stage=$2, detail=$3, type=$4, assignee_kind=$5, assignee_role=$6,
              assignee_user_id=$7, due_offset_days=$8, pos_x=$9, pos_y=$10, sort_order=$11, active=$12,
              updated_at=now()
        where id=$13 and tenant_id=$1`,
      [...vals, input.id]
    );
    id = input.id;
  } else {
    const row = await queryOne<{ id: string }>(
      `insert into task_template (tenant_id, stage, detail, type, assignee_kind, assignee_role,
          assignee_user_id, due_offset_days, pos_x, pos_y, sort_order, active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      vals
    );
    id = row!.id;
  }
  // Email-node fields in a guarded statement so a deploy before migration 043 still saves tasks.
  if (input.nodeKind !== undefined || input.emailTemplateId !== undefined || input.sendMode !== undefined) {
    await query(
      `update task_template set node_kind=$2, email_template_id=$3, send_mode=$4 where id=$1 and tenant_id=$5`,
      [id, input.nodeKind ?? 'TASK', input.nodeKind === 'EMAIL' ? input.emailTemplateId ?? null : null, input.nodeKind === 'EMAIL' ? input.sendMode ?? 'DRAFT' : null, user.tenantId]
    ).catch(() => {});
  }
  return fetchTemplate(user.tenantId, id);
}

export async function deleteTemplate(user: SessionUser, id: string): Promise<void> {
  await query(`delete from task_template where id = $1 and tenant_id = $2`, [id, user.tenantId]);
}

/** Add a DAG edge (prerequisite → dependent), rejecting anything that would form a cycle. */
export async function saveEdge(user: SessionUser, from: string, to: string): Promise<{ ok: boolean; reason?: string }> {
  if (from === to) return { ok: false, reason: 'A task cannot depend on itself.' };
  const edges = await query<TaskEdge>(
    `select from_template_id, to_template_id from task_template_edge where tenant_id = $1`,
    [user.tenantId]
  );
  // Adding from→to creates a cycle iff `from` is already reachable from `to`.
  const adj: Record<string, string[]> = {};
  for (const e of edges) (adj[e.from_template_id] ??= []).push(e.to_template_id);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === from) return { ok: false, reason: 'That would create a cycle.' };
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(adj[n] ?? []));
  }
  await query(
    `insert into task_template_edge (tenant_id, from_template_id, to_template_id)
     values ($1,$2,$3) on conflict (from_template_id, to_template_id) do nothing`,
    [user.tenantId, from, to]
  );
  return { ok: true };
}

export async function deleteEdge(user: SessionUser, from: string, to: string): Promise<void> {
  await query(
    `delete from task_template_edge where tenant_id = $1 and from_template_id = $2 and to_template_id = $3`,
    [user.tenantId, from, to]
  );
}

export async function savePositions(user: SessionUser, positions: Array<{ id: string; x: number; y: number }>): Promise<void> {
  for (const p of positions) {
    await query(`update task_template set pos_x=$2, pos_y=$3, updated_at=now() where id=$1 and tenant_id=$4`, [
      p.id,
      p.x,
      p.y,
      user.tenantId,
    ]).catch(() => {});
  }
}

// ── Instantiation ─────────────────────────────────────────────────────────────────

async function resolveAssignee(
  tenantId: string,
  matterId: string,
  t: TaskTemplate
): Promise<{ assignee: string | null; assigneeUserId: string | null }> {
  const nameOf = async (userId: string) =>
    (await queryOne<{ name: string }>(`select coalesce(display_name, email) as name from app_user where id = $1`, [userId]))?.name ?? null;

  if (t.assignee_kind === 'USER' && t.assignee_user_id) {
    return { assignee: await nameOf(t.assignee_user_id), assigneeUserId: t.assignee_user_id };
  }
  // ROLE
  if (t.assignee_role === 'OWNER') {
    const m = await queryOne<{ assigned_to: string | null }>(`select assigned_to from matter where id = $1 and tenant_id = $2`, [matterId, tenantId]);
    if (m?.assigned_to) return { assignee: await nameOf(m.assigned_to), assigneeUserId: m.assigned_to };
    return { assignee: null, assigneeUserId: null };
  }
  if (t.assignee_role) {
    const u = await queryOne<{ id: string; name: string }>(
      `select id, coalesce(display_name, email) as name from app_user where tenant_id = $1 and role = $2 order by created_at limit 1`,
      [tenantId, t.assignee_role]
    );
    if (u) return { assignee: u.name, assigneeUserId: u.id };
  }
  return { assignee: null, assigneeUserId: null };
}

/** Insert one matter_task from a template. Own ref-lock; app-first (no Excel/To Do fan-out). */
async function createTemplateTask(
  tenantId: string,
  matterId: string,
  createdBy: string,
  t: TaskTemplate,
  assignee: string | null,
  assigneeUserId: string | null,
  status: 'OPEN' | 'BLOCKED' | 'DONE'
): Promise<void> {
  const due =
    t.due_offset_days != null ? new Date(Date.now() + t.due_offset_days * 86_400_000).toISOString().slice(0, 10) : '';
  await transaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [matterId]);
    const last = (
      await client.query<{ ref: string }>(
        `select ref from matter_task where matter_id = $1 and ref ~ '^T-[0-9]+$' order by (substring(ref from 3))::int desc limit 1`,
        [matterId]
      )
    ).rows[0];
    const n = last ? parseInt(last.ref.slice(2), 10) + 1 : 1;
    const ref = `T-${String(n).padStart(4, '0')}`;
    await client.query(
      `insert into matter_task (tenant_id, matter_id, ref, type, detail, assignee, assignee_user_id, due, status, source, created_by, template_id)
       values ($1,$2,$3,$4,$5,$6,$7, nullif($8,'')::date, $9, 'WORKFLOW', $10, $11)`,
      [tenantId, matterId, ref, t.type || 'TASK', t.detail, assignee, assigneeUserId, due, status, createdBy, t.id]
    );
  });
}

const fillVars = (s: string, vars: Record<string, string>) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => vars[k] ?? '');

async function matterEmailVars(tenantId: string, matterId: string): Promise<Record<string, string> | null> {
  const [m, ten, asg] = await Promise.all([
    queryOne<any>(`select * from matter where id=$1 and tenant_id=$2`, [matterId, tenantId]),
    queryOne<{ name: string }>(`select name from tenant where id=$1`, [tenantId]),
    queryOne<{ display_name: string | null; email: string }>(`select u.display_name, u.email from matter m join app_user u on u.id=m.assigned_to where m.id=$1 and m.tenant_id=$2`, [matterId, tenantId]).catch(() => null),
  ]);
  if (!m) return null;
  return buildMatterVars(m, ten?.name ?? 'Your firm', asg?.display_name ?? asg?.email ?? '');
}

/** Fire an EMAIL node: render the template, then draft into the ready-to-send queue (DRAFT) or
 *  actually send it (SEND, only when a recipient is known — otherwise it falls back to a draft). */
async function fireEmailNode(userId: string, tenantId: string, matterId: string, t: TaskTemplate): Promise<void> {
  if (!t.email_template_id) return;
  const tpl = await queryOne<{ name: string; subject_template: string | null; body_template: string }>(
    `select name, subject_template, body_template from template where id=$1 and tenant_id=$2`,
    [t.email_template_id, tenantId]
  ).catch(() => null);
  if (!tpl) return;
  const vars = await matterEmailVars(tenantId, matterId);
  if (!vars) return;
  const subject = fillVars(tpl.subject_template || tpl.name, vars);
  const filled = fillVars(tpl.body_template, vars);
  const body = filled.includes('<') ? filled : `<p>${filled.replace(/\n/g, '<br>')}</p>`;
  let recipient: string | null = null;
  try {
    recipient = (await queryOne<{ email: string }>(
      `select email from matter_contact where matter_id=$1 and tenant_id=$2 and email is not null order by (role='CLIENT') desc, last_seen_at desc limit 1`,
      [matterId, tenantId]
    ))?.email ?? null;
  } catch { /* no contacts table / rows */ }
  const wantsSend = t.send_mode === 'SEND' && !!recipient;
  const draft = await createDraftMessage(userId, subject, body, wantsSend && recipient ? [recipient] : []).catch(() => null);
  if (!draft?.id) return;
  if (wantsSend) {
    await sendDraftMessage(userId, draft.id).catch(() => {}); // sent — nothing further
  } else {
    await addDraftReady({ tenantId, matterId, dedupKey: `wfemail:${t.id}`, title: `Email drafted — ${tpl.name}`, detail: subject, graphMessageId: draft.id }).catch(() => {});
  }
}

/** A matter reached `stage` — create its (not-yet-created) templates, blocking any with an
 *  unfinished prerequisite. Called from onStageAdvanced. */
export async function instantiateStageTemplates(user: SessionUser, matterId: string, stage: string): Promise<number> {
  try {
    const templates = await query<TaskTemplate>(
      `select ${TPL_COLS} from task_template where tenant_id = $1 and stage = $2 and active = true order by sort_order`,
      [user.tenantId, stage]
    );
    if (!templates.length) return 0;

    const existing = new Set(
      (await query<{ template_id: string }>(`select template_id from matter_task where matter_id = $1 and template_id is not null`, [matterId])).map((r) => r.template_id)
    );
    const doneIds = new Set(
      (await query<{ template_id: string }>(`select template_id from matter_task where matter_id = $1 and template_id is not null and status = 'DONE'`, [matterId])).map((r) => r.template_id)
    );
    const edges = await query<TaskEdge>(`select from_template_id, to_template_id from task_template_edge where tenant_id = $1`, [user.tenantId]);
    const prereqs: Record<string, string[]> = {};
    for (const e of edges) (prereqs[e.to_template_id] ??= []).push(e.from_template_id);

    let created = 0;
    for (const t of templates) {
      if (existing.has(t.id)) continue;
      const blocked = (prereqs[t.id] ?? []).some((d) => !doneIds.has(d));
      if (t.node_kind === 'EMAIL') {
        // Fire now if unblocked; track state via a hidden EMAIL row (DONE = fired, BLOCKED = waiting).
        if (!blocked) await fireEmailNode(user.userId, user.tenantId, matterId, t);
        await createTemplateTask(user.tenantId, matterId, user.userId, { ...t, type: 'EMAIL' }, null, null, blocked ? 'BLOCKED' : 'DONE');
      } else {
        const { assignee, assigneeUserId } = await resolveAssignee(user.tenantId, matterId, t);
        await createTemplateTask(user.tenantId, matterId, user.userId, t, assignee, assigneeUserId, blocked ? 'BLOCKED' : 'OPEN');
      }
      created += 1;
    }
    return created;
  } catch {
    return 0; // no workflow / not migrated — never break a stage change
  }
}

/** A workflow task was completed — open (or, for email nodes, fire) any dependents whose
 *  prerequisites are now all DONE. */
export async function unblockDependents(user: { userId: string; tenantId: string }, matterId: string, completedTemplateId: string | null): Promise<void> {
  if (!completedTemplateId) return;
  const tenantId = user.tenantId;
  try {
    const deps = await query<{ to_template_id: string }>(
      `select to_template_id from task_template_edge where tenant_id = $1 and from_template_id = $2`,
      [tenantId, completedTemplateId]
    );
    if (!deps.length) return;
    const doneIds = new Set(
      (await query<{ template_id: string }>(`select template_id from matter_task where matter_id = $1 and template_id is not null and status = 'DONE'`, [matterId])).map((r) => r.template_id)
    );
    const edges = await query<TaskEdge>(`select from_template_id, to_template_id from task_template_edge where tenant_id = $1`, [tenantId]);
    const prereqs: Record<string, string[]> = {};
    for (const e of edges) (prereqs[e.to_template_id] ??= []).push(e.from_template_id);
    // Look up node kind for the dependents (fallback to TASK pre-migration 043).
    const depIds = deps.map((d) => d.to_template_id);
    let byId: Record<string, TaskTemplate> = {};
    try {
      const rows = await query<TaskTemplate>(`select ${TPL_COLS} from task_template where tenant_id = $1 and id = any($2::uuid[])`, [tenantId, depIds]);
      byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    } catch { /* email cols absent — treat all as TASK */ }
    for (const d of deps) {
      const allDone = (prereqs[d.to_template_id] ?? []).every((p) => doneIds.has(p));
      if (!allDone) continue;
      const t = byId[d.to_template_id];
      if (t?.node_kind === 'EMAIL') {
        await fireEmailNode(user.userId, tenantId, matterId, t);
        await query(`update matter_task set status = 'DONE', updated_at = now() where matter_id = $1 and template_id = $2 and status = 'BLOCKED'`, [matterId, d.to_template_id]);
      } else {
        await query(`update matter_task set status = 'OPEN', updated_at = now() where matter_id = $1 and template_id = $2 and status = 'BLOCKED'`, [matterId, d.to_template_id]);
      }
    }
  } catch {
    /* best-effort */
  }
}
