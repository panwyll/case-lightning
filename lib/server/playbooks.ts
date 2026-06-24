/**
 * Playbooks — named multi-step custom actions a firm runs against an email in one
 * go (e.g. "Onboard client" = create matter → generate docs → create tasks → draft
 * reply). Steps run sequentially, "run-all-then-review": nothing is sent, drafts
 * land in Outlook and records are created for the user to check.
 *
 * Each step reuses an existing capability, so a playbook is just orchestration:
 *   CREATE_MATTER   — propose the matter from the thread, provision it, link the email
 *   GENERATE_DOCS   — fill the chosen doc templates into the matter's Case files
 *   CREATE_TASK     — add a task to the matter (synced to the tracker)
 *   DRAFT_REPLY     — draft a case-aware reply to the original email (never sends)
 */
import { query, queryOne } from './db';
import { threadToText } from './text';
import { randomMatterRef } from '../ref-name';
import { listThreadMessages, createReplyDraft, uploadToMatterFolder, createForwardDraft, createDraftMessage } from './graph';
import { proposeMatter, draftReply, draftUpdate, upsertChunks } from './ai';
import { createMatter } from './matter';
import { createTask } from './tasks';
import { generateTemplateForMatter } from './doc-templates';
import { isPremiumTenant } from './plan';
import type { SessionUser } from './types';

export type PlaybookStepType = 'CREATE_MATTER' | 'GENERATE_DOCS' | 'CREATE_TASK' | 'DRAFT_REPLY' | 'ARCHIVE_MATTER' | 'DELEGATE' | 'NOTIFY';

/** Run-time inputs collected from the user before running (dynamic step targets). */
export interface RunInputs {
  delegateToUserId?: string;
  delegateToEmail?: string;
  delegateToName?: string;
  notifyEmail?: string;
  notifyName?: string;
}

/** Starter workflows a firm can load with one click (template IDs are firm-specific,
 *  so the defaults avoid the docs step — admins add it once templates exist). */
export const DEFAULT_PLAYBOOKS: Array<{ name: string; description: string; steps: PlaybookStep[] }> = [
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

export interface PlaybookStep {
  type: PlaybookStepType;
  config: Record<string, any>;
}

export interface Playbook {
  id: string;
  name: string;
  description: string | null;
  steps: PlaybookStep[];
  enabled: boolean;
  sort_order: number;
}

export interface RunContext {
  messageId?: string | null;
  conversationId?: string | null;
  subject?: string | null;
  matterId?: string | null;
}

export interface StepResult {
  type: PlaybookStepType;
  ok: boolean;
  detail: string;
}

export async function listPlaybooks(tenantId: string): Promise<Playbook[]> {
  return query<Playbook>(
    `select id, name, description, steps, enabled, sort_order
     from playbook where tenant_id = $1 order by sort_order, created_at`,
    [tenantId]
  );
}

/** Index a playbook's name + description so the assist can retrieve/suggest it. */
export async function indexPlaybook(tenantId: string, id: string, name: string, description: string | null): Promise<void> {
  await upsertChunks({
    tenantId,
    sourceKind: 'PLAYBOOK',
    sourceId: id,
    text: `Playbook: ${name}\n${description ?? ''}`,
    metadata: { name },
  }).catch(() => {});
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Run a playbook against an email/matter. Steps that fail are recorded but don't
 * abort the rest (each is best-effort + reported), so one bad step doesn't sink
 * the run. `matterId` flows: a CREATE_MATTER step sets it for later steps.
 */
export async function runPlaybook(user: SessionUser, playbookId: string, ctx: RunContext, inputs: RunInputs = {}): Promise<{ matterId: string | null; results: StepResult[] }> {
  const pb = await queryOne<{ steps: PlaybookStep[] }>(
    `select steps from playbook where id = $1 and tenant_id = $2 and enabled = true`,
    [playbookId, user.tenantId]
  );
  if (!pb) throw new Error('Playbook not found or disabled.');

  const steps = Array.isArray(pb.steps) ? pb.steps : [];
  let matterId = ctx.matterId ?? null;
  const results: StepResult[] = [];

  // Read the thread once if we'll need it.
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
        const prop = await proposeMatter({
          userId: user.userId,
          tenantId: user.tenantId,
          threadDigest: threadText || ctx.subject || '',
        });
        const created = await createMatter(user, {
          matterRef: prop.suggestedRef?.trim() || randomMatterRef(),
          propertyAddress: prop.propertyAddress || ctx.subject || 'New matter',
          buyerNames: prop.buyerNames ?? [],
          sellerNames: prop.sellerNames ?? [],
          counterpartySolicitor: prop.counterpartySolicitor,
          counterpartyAgent: prop.counterpartyAgent,
        });
        matterId = created.id;
        // Link the email thread to the new matter.
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
        const draft = await draftReply({
          userId: user.userId,
          tenantId: user.tenantId,
          matterId,
          tone: (step.config.tone as 'NEUTRAL' | 'FIRM' | 'CHASING') || 'NEUTRAL',
          threadText,
          matterFacts: {},
          retrievedContext: '',
          templateText: step.config.templateText || '',
        });
        await createReplyDraft(user.userId, ctx.messageId, draft.bodyHtml);
        results.push({ type: step.type, ok: true, detail: 'Draft reply created in Outlook' });
      } else if (step.type === 'ARCHIVE_MATTER') {
        if (!matterId) throw new Error('no matter to archive');
        await query(
          `update matter set status = 'CLOSED', updated_at = now() where id = $1 and tenant_id = $2`,
          [matterId, user.tenantId]
        );
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
        if (uid) {
          await query(`update matter set assigned_to = $1, updated_at = now() where id = $2 and tenant_id = $3`, [uid, matterId, user.tenantId]);
        }
        if (ctx.messageId) {
          await createForwardDraft(user.userId, ctx.messageId, email, step.config.note || '');
        }
        results.push({ type: step.type, ok: true, detail: `Assigned to ${inputs.delegateToName || email}${ctx.messageId ? ' and forwarded' : ''}` });
      } else if (step.type === 'NOTIFY') {
        if (!matterId) throw new Error('no matter for the notification');
        const email = inputs.notifyEmail || step.config.email;
        if (!email) throw new Error('no recipient chosen');
        const name = inputs.notifyName || email;
        const draft = await draftUpdate({
          userId: user.userId,
          tenantId: user.tenantId,
          matterId,
          recipientName: name,
          recipientRole: 'a contact',
          threadText,
          matterFacts: {},
          retrievedContext: '',
          templateText: '',
        });
        await createDraftMessage(user.userId, draft.subject, draft.bodyHtml, [email]);
        results.push({ type: step.type, ok: true, detail: `Update to ${name} drafted in Outlook` });
      }
    } catch (e) {
      results.push({ type: step.type, ok: false, detail: (e as Error).message });
    }
  }

  return { matterId, results };
}
