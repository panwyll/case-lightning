/**
 * Automations — the ONE "recipe of steps triggered by an email" concept (this used
 * to be two things: auto-rules and playbooks). An automation is a named, ordered list
 * of steps with a trigger:
 *
 *   MANUAL — a person runs it against an open email in one click ("Onboard client").
 *   AUTO   — it fires by itself when an incoming email matches its conditions
 *            (intent / confidence / sender domain / matter stage). Premium; the only
 *            trigger that can send, and only through the cancellable send queue.
 *
 * Steps reuse existing capabilities, so an automation is just orchestration:
 *   CREATE_MATTER · GENERATE_DOCS · CREATE_TASK · DRAFT_REPLY · ARCHIVE_MATTER
 *   DELEGATE · NOTIFY · TAG (categorise in Outlook) · APPEND_TRACKER · ASSIGN
 *
 * Run-all-then-review for MANUAL: nothing sends, drafts land in Outlook. For AUTO a
 * DRAFT_REPLY step may carry `send: true`, which — behind the risk ack, kill-switch
 * and domain allowlist — schedules the send on the standard grace window.
 */
import { query, queryOne } from './db';
import { threadToText } from './text';
import { isMeaningfulRef } from '../ref-name';
import {
  listThreadMessages, createReplyDraft, uploadToMatterFolder, createForwardDraft, createDraftMessage,
  ensureMasterCategory, addMessageCategories, appendTrackerRow,
} from './graph';
import { proposeMatter, draftReply, draftUpdate, retrieveMatterContext, upsertChunks } from './ai';
import { createMatter } from './matter';
import { createTask } from './tasks';
import { generateTemplateForMatter } from './doc-templates';
import { isPremiumTenant } from './plan';
import { scheduleSend } from './scheduledSend';
import { matterColor } from './colors';
import { externalDomainsAllowed } from './guard';
import { hasTrustedLink } from './matching';
import { writeAudit } from './audit';
import type { SessionUser } from './types';
import type { TriageResult } from './triage';

export type AutomationStepType =
  | 'CREATE_MATTER' | 'GENERATE_DOCS' | 'CREATE_TASK' | 'DRAFT_REPLY'
  | 'ARCHIVE_MATTER' | 'DELEGATE' | 'NOTIFY'
  | 'TAG' | 'APPEND_TRACKER' | 'ASSIGN';

export interface AutomationStep {
  type: AutomationStepType;
  config: Record<string, any>;
}

/** Run-time inputs collected from the user before running (dynamic step targets). */
export interface RunInputs {
  delegateToUserId?: string;
  delegateToEmail?: string;
  delegateToName?: string;
  notifyEmail?: string;
  notifyName?: string;
}

export interface Automation {
  id: string;
  name: string;
  description: string | null;
  steps: AutomationStep[];
  enabled: boolean;
  sort_order: number;
  trigger: 'MANUAL' | 'AUTO';
  intents: string[];
  min_confidence: number;
  require_no_attention: boolean;
  sender_domains: string[];
  match_stages: string[];
  risk_accepted: boolean;
  risk_acknowledgement: string | null;
}

export interface RunContext {
  messageId?: string | null;
  conversationId?: string | null;
  subject?: string | null;
  matterId?: string | null;
}

export interface StepResult {
  type: AutomationStepType;
  ok: boolean;
  detail: string;
}

/**
 * Extra context an AUTO run supplies to the step executor: the auto-send safety
 * posture, the matched matter's ref/tracker, and the triage classification (for the
 * TAG / tracker steps). Absent for a MANUAL run — those steps then use step config.
 */
export interface AutoExecOpts {
  auto?: boolean;
  riskAccepted?: boolean;
  policy?: { auto_send_enabled: boolean; allowed_external_domains: string[] };
  recipients?: string[];
  matterRef?: string | null;
  trackerItemId?: string | null;
  classification?: { intent: string; reason: string; needsAttention: boolean };
  automationId?: string;
  tenantId?: string;
  matterIdForAudit?: string;
}

/** Starter automations (all MANUAL) a firm can load with one click. Template IDs are
 *  firm-specific, so the defaults avoid the docs step — admins add it once templates exist. */
export const DEFAULT_AUTOMATIONS: Array<{ name: string; description: string; steps: AutomationStep[] }> = [
  {
    name: 'Onboard client',
    description: 'New instruction → create the matter, open first tasks, and acknowledge by email.',
    steps: [
      { type: 'CREATE_MATTER', config: {} },
      { type: 'CREATE_TASK', config: { detail: 'Open file & run conflict check', dueOffsetDays: 1 } },
      { type: 'CREATE_TASK', config: { detail: 'Send client care letter & request ID/AML documents', dueOffsetDays: 2 } },
      { type: 'DRAFT_REPLY', config: { tone: 'NEUTRAL' } },
    ],
  },
  {
    name: 'Archive case',
    description: 'Completion/closure → log a final file check, archive the matter, and confirm.',
    steps: [
      { type: 'CREATE_TASK', config: { detail: 'Final file check, account & store/destroy per policy', dueOffsetDays: 7 } },
      { type: 'ARCHIVE_MATTER', config: {} },
      { type: 'DRAFT_REPLY', config: { tone: 'NEUTRAL' } },
    ],
  },
  {
    name: 'Chase the other side',
    description: 'Outstanding response → draft a chasing reply and set a follow-up task.',
    steps: [
      { type: 'DRAFT_REPLY', config: { tone: 'CHASING' } },
      { type: 'CREATE_TASK', config: { detail: 'Chase outstanding enquiries / response', dueOffsetDays: 3 } },
    ],
  },
];

const A_COLS =
  `id, name, description, steps, enabled, sort_order, trigger, intents, min_confidence,
   require_no_attention, sender_domains, match_stages, risk_accepted, risk_acknowledgement`;

/**
 * Seed the default MANUAL automations the first time a firm needs them. Concurrency-safe:
 * only the caller that flips `playbooks_seeded` does the inserts.
 */
export async function ensureDefaultAutomations(tenantId: string, userId: string): Promise<void> {
  const won = await queryOne<{ id: string }>(
    `update tenant set playbooks_seeded = true where id = $1 and playbooks_seeded = false returning id`,
    [tenantId]
  );
  if (!won) return;
  for (const a of DEFAULT_AUTOMATIONS) {
    const row = await queryOne<{ id: string }>(
      `insert into automation (tenant_id, name, description, steps, trigger, created_by)
       values ($1,$2,$3,$4::jsonb,'MANUAL',$5) returning id`,
      [tenantId, a.name, a.description, JSON.stringify(a.steps), userId]
    );
    if (row) await indexAutomation(tenantId, row.id, a.name, a.description);
  }
}

/** All automations for the admin, or just one trigger kind. */
export async function listAutomations(tenantId: string, trigger?: 'MANUAL' | 'AUTO'): Promise<Automation[]> {
  return query<Automation>(
    `select ${A_COLS} from automation
     where tenant_id = $1 ${trigger ? 'and trigger = $2' : ''}
     order by sort_order, created_at`,
    trigger ? [tenantId, trigger] : [tenantId]
  );
}

/** Index a MANUAL automation's name + description so the assist can suggest it. */
export async function indexAutomation(tenantId: string, id: string, name: string, description: string | null): Promise<void> {
  await upsertChunks({
    tenantId,
    sourceKind: 'PLAYBOOK',
    sourceId: id,
    text: `Automation: ${name}\n${description ?? ''}`,
    metadata: { name },
  }).catch(() => {});
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Run a saved MANUAL automation against an email/matter. */
export async function runAutomation(user: SessionUser, automationId: string, ctx: RunContext, inputs: RunInputs = {}): Promise<{ matterId: string | null; results: StepResult[] }> {
  const a = await queryOne<{ steps: AutomationStep[] }>(
    `select steps from automation where id = $1 and tenant_id = $2 and enabled = true`,
    [automationId, user.tenantId]
  );
  if (!a) throw new Error('Automation not found or disabled.');
  const steps = Array.isArray(a.steps) ? a.steps : [];
  return executeSteps(user, steps, ctx, inputs);
}

/**
 * Run a list of steps. Steps that fail are recorded but don't abort the rest (each is
 * best-effort + reported). `matterId` flows: a CREATE_MATTER step sets it for later
 * steps. `opts.auto` switches on the AUTO behaviours (sending, tracker/tag defaults).
 */
export async function executeSteps(
  user: SessionUser,
  steps: AutomationStep[],
  ctx: RunContext,
  inputs: RunInputs = {},
  opts: AutoExecOpts = {}
): Promise<{ matterId: string | null; results: StepResult[] }> {
  let matterId = ctx.matterId ?? null;
  const results: StepResult[] = [];

  let threadText = '';
  const needsThread = steps.some((s) => s.type === 'CREATE_MATTER' || s.type === 'DRAFT_REPLY' || s.type === 'NOTIFY');
  if (needsThread && ctx.conversationId) {
    threadText = threadToText(await listThreadMessages(user.userId, ctx.conversationId)).slice(0, 12000);
  }

  for (const step of steps) {
    try {
      if (step.type === 'CREATE_MATTER') {
        if (matterId) {
          results.push({ type: step.type, ok: true, detail: 'A matter is already linked — skipped.' });
          continue;
        }
        const prop = await proposeMatter({ userId: user.userId, tenantId: user.tenantId, threadDigest: threadText || ctx.subject || '' });
        const created = await createMatter(user, {
          matterRef: isMeaningfulRef(prop.suggestedRef) ? prop.suggestedRef!.trim() : '',
          propertyAddress: prop.propertyAddress || ctx.subject || 'New matter',
          buyerNames: prop.buyerNames ?? [],
          sellerNames: prop.sellerNames ?? [],
          counterpartySolicitor: prop.counterpartySolicitor,
          counterpartyAgent: prop.counterpartyAgent,
        });
        matterId = created.id;
        if (ctx.conversationId) {
          await query(
            `insert into email_thread (tenant_id, matter_id, graph_thread_id, graph_conversation_id, subject)
             values ($1,$2,$3,$4,$5)
             on conflict (tenant_id, graph_thread_id) do update set matter_id = excluded.matter_id`,
            [user.tenantId, matterId, ctx.conversationId, ctx.conversationId, ctx.subject ?? null]
          ).catch(() => {});
        }
        results.push({ type: step.type, ok: true, detail: `Created matter ${created.matterRef}` });
      } else if (step.type === 'GENERATE_DOCS') {
        if (!matterId) throw new Error('no matter to generate documents for');
        const templateIds: string[] = step.config.templateIds ?? [];
        if (!templateIds.length) throw new Error('no templates configured');
        const isPremium = await isPremiumTenant(user.tenantId);
        const matter = await queryOne<{ folder_path: string | null }>(
          `select folder_path from matter where id = $1 and tenant_id = $2`,
          [matterId, user.tenantId]
        );
        let made = 0;
        for (const templateId of templateIds) {
          const { buffer, fileName } = await generateTemplateForMatter(user, matterId, templateId, isPremium);
          if (matter?.folder_path) {
            await uploadToMatterFolder(user.userId, matter.folder_path, fileName, buffer);
            made++;
          }
        }
        results.push({ type: step.type, ok: true, detail: `Generated ${made} document(s) into Case files` });
      } else if (step.type === 'CREATE_TASK') {
        if (!matterId) throw new Error('no matter to add a task to');
        const detail: string = (step.config.detail ?? '').trim();
        if (!detail) throw new Error('task has no detail');
        const due = step.config.dueOffsetDays != null ? addDays(Number(step.config.dueOffsetDays)) : null;
        await createTask(user, matterId, { type: step.config.taskType || 'TASK', detail, due, source: 'PLAYBOOK' });
        results.push({ type: step.type, ok: true, detail: `Task added: ${detail}` });
      } else if (step.type === 'DRAFT_REPLY') {
        if (!ctx.messageId || !ctx.conversationId) throw new Error('no email open to reply to');
        // Ground the draft in the matter when we have one (facts + retrieved context).
        let matterFacts: Record<string, unknown> = {};
        let retrievedContext = '';
        if (matterId) {
          const facts = await queryOne<{ facts: Record<string, unknown> }>(
            `select facts from matter_summary where matter_id = $1 and tenant_id = $2`,
            [matterId, user.tenantId]
          ).catch(() => null);
          matterFacts = facts?.facts ?? {};
          const retrieved = await retrieveMatterContext({
            tenantId: user.tenantId, matterId, queryText: 'Acknowledge status update', includePlaybook: true, limit: 6,
          }).catch(() => []);
          retrievedContext = retrieved.map((r: any) => `${r.source_kind}: ${r.chunk_text}`).join('\n---\n');
        }
        const template = step.config.templateId
          ? await queryOne<any>(`select subject_template, body_template from template where id = $1 and tenant_id = $2`, [step.config.templateId, user.tenantId]).catch(() => null)
          : null;
        const templateText = template ? `${template.subject_template ?? ''}\n${template.body_template}` : (step.config.templateText || '');
        const draft = await draftReply({
          userId: user.userId,
          tenantId: user.tenantId,
          matterId,
          tone: (step.config.tone as 'NEUTRAL' | 'FIRM' | 'CHASING') || 'NEUTRAL',
          threadText,
          matterFacts,
          retrievedContext,
          templateText,
        });
        const d = await createReplyDraft(user.userId, ctx.messageId, draft.bodyHtml);

        // AUTO + send: schedule it behind the safety gates. MANUAL never auto-sends.
        if (opts.auto && step.config.send) {
          const sendOk =
            opts.riskAccepted &&
            opts.policy?.auto_send_enabled &&
            externalDomainsAllowed(opts.recipients ?? [], opts.policy?.allowed_external_domains ?? []);
          if (sendOk) {
            const sched = await scheduleSend({
              tenantId: user.tenantId, userId: user.userId, matterId: matterId ?? undefined,
              graphMessageId: d.id, subject: d.subject, recipient: opts.recipients?.[0] ?? null, source: 'REPLY',
            });
            await writeAudit({
              tenantId: user.tenantId, matterId: opts.matterIdForAudit, actorUserId: user.userId,
              actionType: 'AUTO_REPLY_SENT', actionStatus: 'SUCCESS',
              payload: { automationId: opts.automationId, draftId: d.id, scheduledSendId: sched.id, scheduledAt: sched.scheduledAt, scheduled: true, recipients: opts.recipients },
            }).catch(() => {});
            results.push({ type: step.type, ok: true, detail: 'Auto-reply scheduled (on the send delay — cancellable)' });
          } else {
            await writeAudit({
              tenantId: user.tenantId, matterId: opts.matterIdForAudit, actorUserId: user.userId,
              actionType: 'AUTO_REPLY_SENT', actionStatus: 'BLOCKED',
              payload: { automationId: opts.automationId, reason: 'risk/kill-switch/domain check failed' },
            }).catch(() => {});
            results.push({ type: step.type, ok: true, detail: 'Reply drafted (auto-send blocked by safety check)' });
          }
        } else {
          results.push({ type: step.type, ok: true, detail: 'Draft reply created in Outlook' });
        }
      } else if (step.type === 'ARCHIVE_MATTER') {
        if (!matterId) throw new Error('no matter to archive');
        await query(`update matter set status = 'CLOSED', updated_at = now() where id = $1 and tenant_id = $2`, [matterId, user.tenantId]);
        await query(
          `insert into matter_timeline_event (tenant_id, matter_id, event_at, event_type, title)
           values ($1, $2, now(), 'MATTER_ARCHIVED', 'Matter archived')`,
          [user.tenantId, matterId]
        ).catch(() => {});
        results.push({ type: step.type, ok: true, detail: 'Matter archived (closed)' });
      } else if (step.type === 'DELEGATE') {
        if (!matterId) throw new Error('no matter to delegate');
        const uid = inputs.delegateToUserId || step.config.assigneeUserId;
        const email = inputs.delegateToEmail || step.config.email;
        if (!email) throw new Error('no team member chosen');
        if (uid) await query(`update matter set assigned_to = $1, updated_at = now() where id = $2 and tenant_id = $3`, [uid, matterId, user.tenantId]);
        if (ctx.messageId) await createForwardDraft(user.userId, ctx.messageId, email, step.config.note || '');
        results.push({ type: step.type, ok: true, detail: `Assigned to ${inputs.delegateToName || email}${ctx.messageId ? ' and forwarded' : ''}` });
      } else if (step.type === 'NOTIFY') {
        if (!matterId) throw new Error('no matter for the notification');
        const email = inputs.notifyEmail || step.config.email;
        if (!email) throw new Error('no recipient chosen');
        const name = inputs.notifyName || email;
        const draft = await draftUpdate({
          userId: user.userId, tenantId: user.tenantId, matterId, recipientName: name, recipientRole: 'a contact',
          threadText, matterFacts: {}, retrievedContext: '', templateText: '',
        });
        await createDraftMessage(user.userId, draft.subject, draft.bodyHtml, [email]);
        results.push({ type: step.type, ok: true, detail: `Update to ${name} drafted in Outlook` });
      } else if (step.type === 'TAG') {
        if (!ctx.messageId) throw new Error('no email to tag');
        const label = (step.config.label || opts.matterRef || 'CONVEYi').toString();
        await ensureMasterCategory(user.userId, label, matterColor(label));
        await addMessageCategories(user.userId, ctx.messageId, [label]).catch(() => {});
        results.push({ type: step.type, ok: true, detail: `Tagged in Outlook: ${label}` });
      } else if (step.type === 'APPEND_TRACKER') {
        if (!opts.trackerItemId) throw new Error('no Excel tracker for this matter');
        await appendTrackerRow(user.userId, opts.trackerItemId, {
          date: new Date().toISOString().slice(0, 10),
          type: opts.classification?.intent ?? 'NOTE',
          detail: `${opts.classification?.reason ?? ctx.subject ?? ''}`.slice(0, 250),
          owner: '',
          due: '',
          status: opts.classification?.needsAttention ? 'OPEN' : 'NOTED',
        });
        results.push({ type: step.type, ok: true, detail: 'Row added to the Excel tracker' });
      } else if (step.type === 'ASSIGN') {
        if (!matterId) throw new Error('no matter to assign');
        const uid = step.config.assigneeUserId;
        if (!uid) throw new Error('no person chosen to assign to');
        await query(`update matter set assigned_to = $1, updated_at = now() where id = $2 and tenant_id = $3`, [uid, matterId, user.tenantId]);
        await query(
          `insert into matter_timeline_event (tenant_id, matter_id, event_type, title)
           values ($1,$2,'ASSIGNED','Assigned by automation')`,
          [user.tenantId, matterId]
        ).catch(() => {});
        results.push({ type: step.type, ok: true, detail: 'Matter assigned' });
      }
    } catch (e) {
      results.push({ type: step.type, ok: false, detail: (e as Error).message });
    }
  }

  return { matterId, results };
}

export interface AutoOutcome {
  applied: boolean;
  ruleId?: string;
  ruleName?: string;
  actions: string[];
  reason?: string;
}

interface AutoAutomationRow {
  id: string;
  name: string;
  steps: AutomationStep[];
  intents: string[];
  min_confidence: number;
  require_no_attention: boolean;
  sender_domains: string[];
  match_stages: string[];
  risk_accepted: boolean;
}

/**
 * The AUTO trigger: when an incoming email matches an enabled AUTO automation's
 * conditions, run its steps headlessly. Same gates as the old auto-rules:
 *  - AUTO-band match on a firm-created TRUSTED LINK (never a body-injectable token),
 *  - tenant automation kill-switch on, premium tenant,
 *  - the automation's intent / confidence / no-attention / domain / stage conditions.
 * A sending DRAFT_REPLY step additionally needs the risk ack + send switch + domain policy.
 */
export async function runAutoAutomations(user: SessionUser, message: any, triage: TriageResult): Promise<AutoOutcome> {
  if (!triage.top || triage.top.band !== 'AUTO') {
    return { applied: false, actions: [], reason: 'No AUTO-band match; left for human review.' };
  }
  if (!hasTrustedLink(triage.top)) {
    return { applied: false, actions: [], reason: 'Match is not an explicitly-linked thread; auto-automations require a confirmed link.' };
  }

  const policy = await queryOne<{ automation_enabled: boolean; auto_send_enabled: boolean; allowed_external_domains: string[] }>(
    `select automation_enabled, auto_send_enabled, allowed_external_domains from policy_config where tenant_id = $1`,
    [user.tenantId]
  );
  if (!policy?.automation_enabled) return { applied: false, actions: [], reason: 'Automation disabled for this firm.' };
  if (!(await isPremiumTenant(user.tenantId))) return { applied: false, actions: [], reason: 'Premium automation requires the Pro or Firm plan.' };

  const autos = await query<AutoAutomationRow>(
    `select id, name, steps, intents, min_confidence, require_no_attention, sender_domains, match_stages, risk_accepted
     from automation where tenant_id = $1 and trigger = 'AUTO' and enabled = true order by min_confidence desc`,
    [user.tenantId]
  );

  const senderDomain = message.from?.emailAddress?.address?.split('@')[1]?.toLowerCase();
  const match = triage.top;
  const cls = triage.classification;

  const matter = await queryOne<{ stage: string | null; tracker_item_id: string | null; matter_ref: string | null }>(
    `select stage, tracker_item_id, matter_ref from matter where id = $1 and tenant_id = $2`,
    [match.matterId, user.tenantId]
  );

  const chosen = autos.find((a) => {
    if (a.intents.length && !a.intents.includes(cls.intent)) return false;
    if (match.score < a.min_confidence) return false;
    if (a.require_no_attention && cls.needsAttention) return false;
    if (a.sender_domains.length && (!senderDomain || !a.sender_domains.includes(senderDomain))) return false;
    if (a.match_stages.length && (!matter?.stage || !a.match_stages.includes(matter.stage))) return false;
    return true;
  });
  if (!chosen) return { applied: false, actions: [], reason: 'No enabled automation matched this email.' };

  // Foundational: link the thread to the matched matter so steps have context.
  await query(
    `insert into email_thread (tenant_id, matter_id, graph_thread_id, graph_conversation_id, subject, outlook_category)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (tenant_id, graph_thread_id) do update set matter_id = excluded.matter_id`,
    [user.tenantId, match.matterId, message.conversationId ?? message.id, message.conversationId ?? null, message.subject ?? null, match.matterRef]
  );

  const recipients = [
    message.from?.emailAddress?.address,
    ...(message.toRecipients ?? []).map((r: any) => r.emailAddress?.address),
  ].filter(Boolean) as string[];

  const { results } = await executeSteps(
    user,
    chosen.steps,
    { messageId: message.id, conversationId: message.conversationId ?? message.id, subject: message.subject ?? null, matterId: match.matterId },
    {},
    {
      auto: true,
      riskAccepted: chosen.risk_accepted,
      policy: { auto_send_enabled: policy.auto_send_enabled, allowed_external_domains: policy.allowed_external_domains ?? [] },
      recipients,
      matterRef: match.matterRef,
      trackerItemId: matter?.tracker_item_id ?? null,
      classification: { intent: cls.intent, reason: cls.reason, needsAttention: cls.needsAttention },
      automationId: chosen.id,
      matterIdForAudit: match.matterId,
    }
  );

  const actions = ['linked-thread', ...results.filter((r) => r.ok).map((r) => r.type)];
  await writeAudit({
    tenantId: user.tenantId,
    matterId: match.matterId,
    actorUserId: user.userId,
    actionType: 'AUTO_RULE_APPLIED',
    actionStatus: 'SUCCESS',
    payload: { automationId: chosen.id, ruleName: chosen.name, actions },
  }).catch(() => {});

  return { applied: true, ruleId: chosen.id, ruleName: chosen.name, actions };
}
