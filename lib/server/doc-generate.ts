/**
 * Generating a firm's document for one case from the Doc Packs tab. What a document says is the
 * firm's to change; when it may be produced is not: each standard document may only be made for a
 * case that has reached its step (the same point the flow produces it at). The report on title and
 * the completion statement are the engine's own drafts, so generating one runs the engine's draft
 * (it then waits for approval like any other); every other template is filled and filed on the case.
 */
import crypto from 'node:crypto';
import PizZip from 'pizzip';
import { query, queryOne } from './db';
import { putBlob } from './blob-store';
import { engine } from './engine/adapters';
import { profileOf } from './engine/transactions';
import { STAGES, isResolved, type MatterState, type Stage } from './engine/types';
import { generateTemplateForMatter, templateOutputName } from './doc-templates';
import { isPremiumTenant, canUseHeavyLlm } from './plan';
import { uploadToMatterFolder } from './graph';
import { driveUserFor } from './matter-drive';
import type { SessionUser } from './types';

const atLeast = (s: MatterState, stage: Stage) => STAGES.indexOf(s.stage) >= STAGES.indexOf(stage);
const buyer = (s: MatterState) => profileOf(s.transactionType ?? 'freehold_purchase').side === 'buyer';
const seller = (s: MatterState) => profileOf(s.transactionType ?? 'freehold_purchase').side === 'seller';

/** For each standard document: null when the case has reached its step, otherwise why not yet. */
const READY: Record<string, (s: MatterState) => string | null> = {
  'Client care letter': (s) => (s.enrolled ? null : 'Not enrolled yet'),
  'Deposit request letter': (s) => (!buyer(s) ? 'Only on a purchase' : s.readiness.contractApprovedAt ? null : 'Contract not approved yet'),
  'Exchange confirmation letter': (s) => (s.exchange.exchangedAt ? null : 'Not exchanged yet'),
  'Completion statement': (s) => (atLeast(s, 'pre_exchange') ? null : 'Not at pre-exchange yet'),
  'Completion letter': (s) => (s.completion.confirmedAt ? null : 'Completion not confirmed yet'),
  'Contract pack covering letter': (s) => (!seller(s) ? 'Only on a sale' : s.title.documentId ? null : 'Official copies not in yet'),
  'Report on title': (s) => {
    if (!buyer(s)) return 'Only on a purchase';
    if (s.reportOnTitle.status === 'drafted') return 'A draft is waiting for approval in Tasks';
    if (s.reportOnTitle.status === 'approved' || s.reportOnTitle.status === 'sent') return `Already ${s.reportOnTitle.status}`;
    if (!isResolved(s.title.status)) return s.title.documentId ? 'Title not resolved yet' : 'Official copies not in yet';
    if (s.stage !== 'contract_review') return atLeast(s, 'pre_exchange') ? 'Past the report stage' : 'Searches, enquiries or the mortgage offer still open';
    return null;
  },
};

export interface CaseChoice { matterId: string; matterRef: string | null; propertyAddress: string | null; ready: boolean; reason: string | null }

export async function casesForTemplate(user: SessionUser, templateId: string): Promise<{ template: string; cases: CaseChoice[] }> {
  const tpl = await queryOne<{ name: string }>(`select name from doc_template where id = $1 and tenant_id = $2`, [templateId, user.tenantId]);
  if (!tpl) throw Object.assign(new Error('Template not found.'), { status: 404 });
  const rule = READY[tpl.name];
  const matters = await query<{ id: string; matter_ref: string | null; property_address: string | null }>(
    `select id, matter_ref, property_address from matter where tenant_id = $1 and coalesce(status, 'OPEN') = 'OPEN' and coalesce(sandbox, false) = false order by updated_at desc nulls last limit 300`,
    [user.tenantId]
  ).catch(() => query<{ id: string; matter_ref: string | null; property_address: string | null }>(`select id, matter_ref, property_address from matter where tenant_id = $1 order by created_at desc limit 300`, [user.tenantId]));
  const svc = engine();
  const cases = await Promise.all(matters.map(async (m): Promise<CaseChoice> => {
    let reason: string | null = null;
    if (rule) {
      const s = await svc.getState(user.tenantId, m.id).catch(() => null);
      reason = !s || !s.enrolled ? 'Not enrolled yet' : s.closedAt || s.abandoned ? 'Closed' : rule(s);
    }
    return { matterId: m.id, matterRef: m.matter_ref, propertyAddress: m.property_address, ready: !reason, reason };
  }));
  cases.sort((a, b) => Number(b.ready) - Number(a.ready));
  return { template: tpl.name, cases };
}

/** The words of a .docx, paragraph by paragraph: enough to see it filled in properly. */
export function docxText(buffer: Buffer): string {
  try {
    const xml = new PizZip(buffer).file('word/document.xml')?.asText() ?? '';
    return xml.split(/<\/w:p>/).map((p) => p.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")).map((l) => l.replace(/[ \t]+$/g, '').replace(/^\s+/, '')).filter((l, i, all) => l || (i > 0 && all[i - 1])).join('\n').trim();
  } catch { return ''; }
}

export interface Generated { matterId: string; name: string; documentId: string; fileName: string; preview: string; webUrl: string | null; /** The engine's own draft: it waits for approval in Tasks. */ decisionEventId: string | null; capped: boolean }

export async function generateForCase(user: SessionUser, templateId: string, matterId: string): Promise<Generated> {
  const tpl = await queryOne<{ name: string; has_llm_prompts: boolean }>(`select name, has_llm_prompts from doc_template where id = $1 and tenant_id = $2`, [templateId, user.tenantId]);
  if (!tpl) throw Object.assign(new Error('Template not found.'), { status: 404 });
  const svc = engine();
  const rule = READY[tpl.name];
  if (rule) {
    const s = await svc.getState(user.tenantId, matterId);
    const why = !s.enrolled ? 'Not enrolled yet' : rule(s);
    if (why) throw Object.assign(new Error(`Not yet for this case: ${why.charAt(0).toLowerCase()}${why.slice(1)}.`), { status: 409 });
  }
  const textOf = async (id: string) => (await queryOne<{ content: string | null }>(`select extracted_facts->>'content' as content from document where id = $1 and tenant_id = $2`, [id, user.tenantId]))?.content ?? '';

  if (tpl.name === 'Report on title') {
    const r = await svc.draftReportOnTitle(user.tenantId, matterId);
    const s = r.state;
    const docId = s.reportOnTitle.draftDocumentId as string;
    const decision = Object.values(s.decisions).find((d) => d.kind === 'report_on_title' && d.status === 'pending');
    return { matterId, name: tpl.name, documentId: docId, fileName: 'Report on title (draft)', preview: await textOf(docId), webUrl: null, decisionEventId: decision?.eventId ?? null, capped: false };
  }
  if (tpl.name === 'Completion statement') {
    const r = await svc.draftCompletionStatement(user.tenantId, matterId);
    return { matterId, name: tpl.name, documentId: r.documentId, fileName: 'Completion statement (draft)', preview: await textOf(r.documentId), webUrl: null, decisionEventId: null, capped: false };
  }

  let useAi = await isPremiumTenant(user.tenantId);
  let capped = false;
  if (useAi && tpl.has_llm_prompts && !(await canUseHeavyLlm(user.tenantId)).allowed) { useAi = false; capped = true; }
  const { buffer } = await generateTemplateForMatter(user, matterId, templateId, useAi);
  const fileName = templateOutputName(tpl.name);
  const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const doc = await queryOne<{ id: string }>(
    `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type, created_by)
     values ($1,$2,'GENERATED',$3,$4,$5,$6,$7,'GENERATED_DOCUMENT',$8) returning id`,
    [user.tenantId, matterId, `generated://${templateId}`, fileName, mime, buffer.length, hash, user.userId]
  );
  await putBlob(user.tenantId, doc!.id, buffer, { mime });
  // Into the case's folder too, where the firm keeps its files (when it has one).
  let webUrl: string | null = null;
  const m = await queryOne<{ folder_path: string | null }>(`select folder_path from matter where id = $1 and tenant_id = $2`, [matterId, user.tenantId]);
  if (m?.folder_path) {
    const owner = await driveUserFor(user.tenantId, matterId, user.userId).catch(() => null);
    if (owner) webUrl = (await uploadToMatterFolder(owner, m.folder_path, fileName, buffer).catch(() => null))?.webUrl ?? null;
  }
  return { matterId, name: tpl.name, documentId: doc!.id, fileName, preview: docxText(buffer), webUrl, decisionEventId: null, capped };
}
