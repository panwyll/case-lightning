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
import { listThreadMessages, createReplyDraft, uploadToMatterFolder } from './graph';
import { proposeMatter, draftReply, upsertChunks } from './ai';
import { createMatter } from './matter';
import { createTask } from './tasks';
import { generateTemplateForMatter } from './doc-templates';
import { isPremiumTenant } from './plan';
import type { SessionUser } from './types';

export type PlaybookStepType = 'CREATE_MATTER' | 'GENERATE_DOCS' | 'CREATE_TASK' | 'DRAFT_REPLY';

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
export async function runPlaybook(user: SessionUser, playbookId: string, ctx: RunContext): Promise<{ matterId: string | null; results: StepResult[] }> {
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
  const needsThread = steps.some((s) => s.type === 'CREATE_MATTER' || s.type === 'DRAFT_REPLY');
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
      }
    } catch (e) {
      results.push({ type: step.type, ok: false, detail: (e as Error).message });
    }
  }

  return { matterId, results };
}
