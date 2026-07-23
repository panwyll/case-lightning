/**
 * New-firm onboarding — the admin "Get started" checklist and the one-click firm
 * provisioner. Distinct from onboarding.ts (which imports an existing mailbox backlog).
 *
 * Most step completion is DERIVED from real signals (does the firm have a workflow, doc
 * templates, a matter…) so the checklist reflects reality even if the firm set things up
 * the long way round. onboarding_state (jsonb on tenant) only stores the few things we
 * can't infer: an explicit acknowledgement, or "skip team invites".
 */
import { query, queryOne } from './db';
import { ensureDefaultWorkflow } from './workflow';
import { EXAMPLE_TEMPLATES, createMinimalDocx } from './doc-templates';
import { DEFAULT_AUTOMATIONS, indexAutomation } from './automations';
import type { SessionUser } from './types';

export interface OnboardingStep {
  key: 'firm' | 'workspace' | 'caseflow' | 'matter' | 'team' | 'plan';
  title: string;
  detail: string;
  done: boolean;
}
export interface OnboardingStatus {
  firmName: string;
  isDefaultName: boolean;
  onboarded: boolean;
  dismissed: boolean;
  steps: OnboardingStep[];
  completed: number;
  total: number;
}

const isDefault = (name: string | null | undefined) => !name || /^Tenant[-\s]/i.test(name.trim());

export async function getOnboardingStatus(tenantId: string): Promise<OnboardingStatus> {
  const t = await queryOne<{ name: string | null; onboarded_at: string | null; onboarding_state: any }>(
    `select name, onboarded_at, onboarding_state from tenant where id = $1`,
    [tenantId]
  );
  const state: Record<string, boolean> = (t?.onboarding_state as any) ?? {};
  const num = async (sql: string) => (await queryOne<{ n: number }>(sql, [tenantId]).catch(() => ({ n: 0 })))?.n ?? 0;
  const [docCount, autoCount, matterCount, userCount, inviteCount, seeded, billing] = await Promise.all([
    num(`select count(*)::int as n from doc_template where tenant_id = $1`),
    num(`select count(*)::int as n from automation where tenant_id = $1`),
    num(`select count(*)::int as n from matter where tenant_id = $1`),
    num(`select count(*)::int as n from app_user where tenant_id = $1`),
    num(`select count(*)::int as n from team_invite where tenant_id = $1 and status = 'PENDING'`),
    queryOne<{ workflow_seeded: boolean }>(`select workflow_seeded from tenant where id = $1`, [tenantId]).catch(() => null),
    queryOne<{ plan: string | null; status: string | null; comp_plan: string | null }>(
      `select plan, status, comp_plan from billing_account where tenant_id = $1`,
      [tenantId]
    ).catch(() => null),
  ]);

  const hasPlan = !!(billing?.comp_plan || (billing?.status && billing.status !== 'none') || (billing?.plan && billing.plan !== 'free'));
  const steps: OnboardingStep[] = [
    { key: 'firm', title: 'Name your firm', detail: 'So letters and emails go out under the right name.', done: !isDefault(t?.name) },
    { key: 'workspace', title: 'Set up your workspace', detail: 'Seed the conveyancing workflow, document templates and starter automations.', done: !!(seeded?.workflow_seeded && docCount > 0 && autoCount > 0) || !!state.workspace },
    { key: 'caseflow', title: 'Tune your Case Flow', detail: 'Review the stages, tasks, documents and emails your matters will run through.', done: !!state.caseflow },
    { key: 'matter', title: 'Create your first matter', detail: 'Start a matter, or import your existing cases from your inbox.', done: matterCount > 0 },
    { key: 'team', title: 'Invite your team', detail: 'Bring colleagues in with the right role.', done: userCount > 1 || inviteCount > 0 || !!state.team },
    { key: 'plan', title: 'Choose your plan', detail: 'Start your trial or pick a plan when you’re ready.', done: hasPlan || !!state.plan },
  ];
  const completed = steps.filter((s) => s.done).length;
  return {
    firmName: t?.name ?? '',
    isDefaultName: isDefault(t?.name),
    onboarded: !!t?.onboarded_at,
    dismissed: !!state.dismissed,
    steps,
    completed,
    total: steps.length,
  };
}

/** Merge a patch into onboarding_state (used to acknowledge/skip steps and to dismiss). */
export async function patchOnboardingState(tenantId: string, patch: Record<string, boolean>): Promise<void> {
  await query(`update tenant set onboarding_state = coalesce(onboarding_state, '{}'::jsonb) || $2::jsonb where id = $1`, [
    tenantId,
    JSON.stringify(patch),
  ]);
}

export async function setFirmName(tenantId: string, name: string): Promise<void> {
  const clean = name.trim().slice(0, 120);
  if (!clean) throw new Error('Firm name is required.');
  await query(`update tenant set name = $2 where id = $1`, [tenantId, clean]);
}

export async function markOnboarded(tenantId: string): Promise<void> {
  await query(`update tenant set onboarded_at = coalesce(onboarded_at, now()) where id = $1`, [tenantId]);
}

/** One click to make an empty firm usable: seed the default workflow, example document
 *  templates and starter automations. Idempotent — safe to re-run. */
export async function provisionFirm(user: SessionUser): Promise<{ workflow: boolean; docTemplates: number; automations: number }> {
  const tenantId = user.tenantId;
  // 1. Default conveyancing task/stage DAG.
  await ensureDefaultWorkflow(tenantId).catch(() => {});

  // 2. Example document templates (client care letter, completion statement, report on title).
  let docTemplates = 0;
  for (const tpl of EXAMPLE_TEMPLATES) {
    const exists = await queryOne<{ id: string }>(`select id from doc_template where tenant_id = $1 and name = $2`, [tenantId, tpl.name]).catch(() => null);
    if (exists) continue;
    try {
      const content = createMinimalDocx(tpl.paragraphs);
      await query(
        `insert into doc_template (tenant_id, name, description, file_name, file_content, file_size_bytes, has_llm_prompts, sort_order, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenantId, tpl.name, tpl.description, tpl.fileName, content, content.length, tpl.hasLlmPrompts, EXAMPLE_TEMPLATES.indexOf(tpl), user.userId]
      );
      docTemplates += 1;
    } catch { /* skip a template that won't insert */ }
  }

  // 3. Starter automations.
  let automations = 0;
  for (const a of DEFAULT_AUTOMATIONS) {
    const exists = await queryOne<{ id: string }>(`select id from automation where tenant_id = $1 and name = $2`, [tenantId, a.name]).catch(() => null);
    if (exists) continue;
    try {
      const row = await queryOne<{ id: string }>(
        `insert into automation (tenant_id, name, description, steps, trigger, created_by)
         values ($1,$2,$3,$4::jsonb,'MANUAL',$5) returning id`,
        [tenantId, a.name, a.description, JSON.stringify(a.steps), user.userId]
      );
      if (row) { await indexAutomation(tenantId, row.id, a.name, a.description).catch(() => {}); automations += 1; }
    } catch { /* skip */ }
  }

  await patchOnboardingState(tenantId, { workspace: true });
  return { workflow: true, docTemplates, automations };
}
