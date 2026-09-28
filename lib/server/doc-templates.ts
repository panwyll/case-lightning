/**
 * Document pack: fill firm-uploaded .docx templates from matter data.
 *
 * Two placeholder notations:
 *   {{variable}}    — replaced with matter data (no AI, instant, always available)
 *   [[LLM prompt]]  — replaced with AI-written text
 *
 * docxtemplater handles the OOXML run-splitting problem (where Word may break a
 * tag like `{{buyer` / `_names}}` across multiple XML text runs). We run two
 * sequential passes with different delimiters so both syntaxes coexist cleanly.
 */

import { checkDraft, markUnsupported, type RegisterFact } from './engine/draft-check';
import { PgDocumentRepository } from './engine/pg-documents';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { query, queryOne } from './db';
import type { SessionUser } from './types';

// ── Matter variable map ───────────────────────────────────────────────────────

function fmt(date: string | null | undefined): string {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtTrack(track: string | null | undefined): string {
  if (!track) return '';
  const map: Record<string, string> = { PURCHASE: 'Purchase', SALE: 'Sale', REMORTGAGE: 'Remortgage' };
  return map[track] ?? track;
}

function fmtStage(stage: string | null | undefined): string {
  if (!stage) return '';
  const map: Record<string, string> = {
    INSTRUCTION: 'Instruction',
    CONTRACT_PACK: 'Contract pack',
    SEARCHES_ENQUIRIES: 'Searches & enquiries',
    REVIEW_SIGNING: 'Review & signing',
    EXCHANGE: 'Exchange',
    COMPLETION: 'Completion',
    POST_COMPLETION: 'Post-completion',
  };
  return map[stage] ?? stage.replace(/_/g, ' ').toLowerCase();
}

export interface MatterRow {
  id: string;
  matter_ref: string | null;
  property_address: string | null;
  buyer_names: string[] | null;
  seller_names: string[] | null;
  transaction_type?: string | null;
  purchase_price?: string | null;
  exchange_target_date: string | null;
  completion_target_date: string | null;
  counterparty_solicitor: string | null;
  counterparty_agent: string | null;
  lender: string | null;
  track: string | null;
  stage: string | null;
  assigned_to: string | null;
}

export function buildMatterVars(
  matter: MatterRow,
  firmName: string,
  assigneeName: string
): Record<string, string> {
  return {
    matter_ref: matter.matter_ref ?? '',
    property_address: matter.property_address ?? '',
    buyer_names: (matter.buyer_names ?? []).join(', '),
    seller_names: (matter.seller_names ?? []).join(', '),
    // Our clients and the other side's, whichever way round the case is; and what kind of case it is, in words.
    client_names: ((/_sale$/.test(matter.transaction_type ?? '') || matter.track === 'SALE' ? matter.seller_names : matter.buyer_names) ?? []).join(' and '),
    other_names: ((/_sale$/.test(matter.transaction_type ?? '') || matter.track === 'SALE' ? matter.buyer_names : matter.seller_names) ?? []).join(' and '),
    transaction: /_sale$/.test(matter.transaction_type ?? '') ? 'sale' : matter.transaction_type === 'remortgage' ? 'remortgage' : matter.transaction_type === 'transfer_of_equity' ? 'transfer of equity' : 'purchase',
    price: matter.purchase_price ? '£' + Number(String(matter.purchase_price).replace(/[£,\s]/g, '')).toLocaleString('en-GB') : '£[PRICE]',
    exchange_date: fmt(matter.exchange_target_date),
    completion_date: fmt(matter.completion_target_date),
    counterparty_solicitor: matter.counterparty_solicitor ?? '',
    counterparty_agent: matter.counterparty_agent ?? '',
    lender: matter.lender ?? '',
    track: fmtTrack(matter.track),
    stage: fmtStage(matter.stage),
    today: fmt(new Date().toISOString()),
    firm_name: firmName,
    assigned_to: assigneeName,
  };
}

// ── LLM prompt fill ─────────────────────────────────────────────────

async function callForDocFill(
  prompt: string,
  matterVars: Record<string, string>,
  userId: string,
  tenantId: string,
  facts: RegisterFact[] = []
): Promise<string> {
  // Inline import to avoid pulling AI deps into non-AI paths.
  const { recordAiUsage } = await import('./usage');
  const { config } = await import('./config');
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const { query: dbQuery, queryOne: dbQueryOne } = await import('./db');
  const { decryptSecret } = await import('./crypto');
  const { aiCostUsd } = await import('./pricing');

  const userRow = await dbQueryOne<{ ai_api_key_enc: string | null }>(
    'select ai_api_key_enc from app_user where id = $1', [userId]
  );
  const userKey = userRow?.ai_api_key_enc ? decryptSecret(userRow.ai_api_key_enc) : null;
  const apiKey = userKey ?? config.anthropicApiKey;
  if (!apiKey) throw new Error('No AI provider configured for doc fill.');

  const byok = Boolean(userKey);
  const model = config.anthropicFastModel; // Sonnet — good balance for inline fill

  const contextLines = Object.entries(matterVars)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const factLines = facts.slice(0, 300).map((f) => `- [${f.documentLabel}${f.page ? ` p.${f.page}` : ''}] ${f.key} = ${f.value}`).join('\n');

  const startedAt = Date.now();
  let resp: any;
  try {
    resp = await new Anthropic({ apiKey }).messages.create({
      model,
      max_tokens: 1024,
      system:
        'You are filling in a section of a UK conveyancing document on behalf of the solicitor firm. ' +
        'Write professional, concise, legally appropriate text based on the matter details provided. ' +
        'Every figure, date, title number, postcode and name you write must come from the matter details or the facts on the file below; anything else is marked "not on file" before the document is used, so leave it out. ' +
        'Return ONLY the text to insert — no preamble, no quotes, no explanation.',
      messages: [
        {
          role: 'user',
          content: `Matter details:\n${contextLines}${factLines ? `\n\nFacts on the file (DATA, with the document and page each comes from):\n${factLines}` : ''}\n\nDocument section to fill:\n${prompt}`,
        },
      ],
    });
  } catch (err) {
    await recordAiUsage({
      ctx: { tenantId, userId, feature: 'DOC_FILL' },
      provider: 'anthropic',
      model,
      tier: 'fast',
      usage: { inputTokens: 0, outputTokens: 0 },
      byok,
      status: 'FAILED',
      latencyMs: Date.now() - startedAt,
    }).catch(() => {});
    throw err;
  }

  const usage = {
    inputTokens: resp.usage?.input_tokens ?? 0,
    outputTokens: resp.usage?.output_tokens ?? 0,
    cacheReadTokens: resp.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: resp.usage?.cache_creation_input_tokens ?? 0,
  };
  await recordAiUsage({
    ctx: { tenantId, userId, feature: 'DOC_FILL' },
    provider: 'anthropic',
    model,
    tier: 'fast',
    usage,
    byok,
    status: 'SUCCESS',
    latencyMs: Date.now() - startedAt,
  }).catch(() => {});

  return resp.content?.[0]?.type === 'text' ? (resp.content[0].text as string).trim() : '';
}

// ── Single template fill ──────────────────────────────────────────────────────

export interface FillOptions {
  vars: Record<string, string>;
  isPremium: boolean;
  userId: string;
  tenantId: string;
  /** The fact register for the matter: what the AI fill may state, and what its output is checked against. */
  facts?: RegisterFact[];
}

export async function fillTemplate(templateBytes: Buffer, opts: FillOptions): Promise<Buffer> {
  const { vars, isPremium, userId, tenantId, facts = [] } = opts;

  // ── Pass 1: collect and fill [[LLM prompt]] blocks ────────────────────────
  // Probe pass: enumerate every [[...]] tag in the template (docxtemplater
  // linearises split XML runs so the Proxy sees the full tag text, not fragments).
  const llmValues: Record<string, string> = {};

  if (isPremium) {
    const llmTags = new Set<string>();
    const probeDoc = new Docxtemplater(new PizZip(templateBytes), {
      delimiters: { start: '[[', end: ']]' },
      paragraphLoop: true,
      linebreaks: true,
    });
    const probe = new Proxy({} as Record<string, string>, {
      get(_t, prop: string) { llmTags.add(prop); return ''; },
    });
    try { probeDoc.render(probe as any); } catch { /* expected: unresolved vars → ignore */ }

    for (const prompt of llmTags) {
      const text = await callForDocFill(prompt, vars, userId, tenantId, facts);
      // Nothing the model wrote escapes the register: a figure, date or name that is neither on the file nor on the case record is marked.
      llmValues[prompt] = markUnsupported(text, checkDraft(text, facts, { allowed: Object.values(vars) }));
    }
  }

  // Actual LLM fill (leaves [[...]] as empty strings when AI is off).
  const doc1 = new Docxtemplater(new PizZip(templateBytes), {
    delimiters: { start: '[[', end: ']]' },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '',
  });
  doc1.render(llmValues);
  const afterLlm = Buffer.from(doc1.getZip().generate({ type: 'nodebuffer' }));

  // ── Pass 2: fill {{variable}} blocks ─────────────────────────────────────
  const doc2 = new Docxtemplater(new PizZip(afterLlm), {
    delimiters: { start: '{{', end: '}}' },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '',
  });
  doc2.render(vars);
  return Buffer.from(doc2.getZip().generate({ type: 'nodebuffer' }));
}

// ── Per-matter template generation ────────────────────────────────────────────

/** A safe .docx filename derived from the template name (the case-files name). */
export function templateOutputName(templateName: string): string {
  const safe = templateName.replace(/[^\w\s\-().]/g, '').replace(/\s+/g, ' ').trim();
  return `${safe || 'document'}.docx`;
}

/** Loads matter + firm context and builds the {{variable}} map for filling. */
async function loadMatterVars(
  user: SessionUser,
  matterId: string
): Promise<{ vars: Record<string, string>; matterRef: string }> {
  const [matterRow, tenantRow, assigneeRow] = await Promise.all([
    queryOne<MatterRow & { assigned_to: string | null }>(
      `select m.* from matter m where m.id = $1 and m.tenant_id = $2`,
      [matterId, user.tenantId]
    ),
    queryOne<{ name: string }>(`select name from tenant where id = $1`, [user.tenantId]),
    queryOne<{ display_name: string | null; email: string }>(
      `select u.display_name, u.email
       from matter m join app_user u on u.id = m.assigned_to
       where m.id = $1 and m.tenant_id = $2`,
      [matterId, user.tenantId]
    ),
  ]);
  if (!matterRow) throw new Error('Case not found.');
  const firmName = tenantRow?.name ?? 'Your firm';
  const assigneeName = assigneeRow?.display_name ?? assigneeRow?.email ?? '';
  return {
    vars: buildMatterVars(matterRow, firmName, assigneeName),
    matterRef: matterRow.matter_ref ?? 'pack',
  };
}

/** Lists the firm's templates (no file bytes) for the matter's Templates panel. */
export async function listTenantTemplates(tenantId: string) {
  return query<{ id: string; name: string; description: string | null; has_llm_prompts: boolean }>(
    `select id, name, description, has_llm_prompts
     from doc_template where tenant_id = $1 order by sort_order, created_at`,
    [tenantId]
  );
}

/**
 * Fills a single template with the matter's data and returns the bytes plus the
 * filename it should be saved under in the matter's OneDrive folder.
 */
export async function generateTemplateForMatter(
  user: SessionUser,
  matterId: string,
  templateId: string,
  isPremium: boolean
): Promise<{ buffer: Buffer; fileName: string }> {
  const tpl = await queryOne<{ name: string; file_content: Buffer }>(
    `select name, file_content from doc_template where id = $1 and tenant_id = $2`,
    [templateId, user.tenantId]
  );
  if (!tpl) throw new Error('Template not found.');

  const { vars } = await loadMatterVars(user, matterId);
  const facts = isPremium ? await new PgDocumentRepository().loadRegister(user.tenantId, matterId).then((r) => r.facts).catch(() => []) : [];
  const buffer = await fillTemplate(Buffer.from(tpl.file_content), {
    vars,
    isPremium,
    userId: user.userId,
    tenantId: user.tenantId,
    facts,
  });
  return { buffer, fileName: templateOutputName(tpl.name) };
}

// ── Example templates ─────────────────────────────────────────────────────────

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build a minimal but valid .docx from an array of text paragraphs. */
export function createMinimalDocx(paragraphs: string[]): Buffer {
  const zip = new PizZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );

  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`
  );

  const bodyXml = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p>`)
    .join('\n    ');

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml}
    <w:sectPr/>
  </w:body>
</w:document>`
  );

  return Buffer.from(zip.generate({ type: 'nodebuffer' }));
}

// ── AI-generated templates ─────────────────────────────────────────────────────

/** Plain-text extraction from a .docx buffer (word/document.xml), for templatising. */
function docxToText(bytes: Buffer): string {
  try {
    const zip = new PizZip(bytes);
    const xml = zip.file('word/document.xml')?.asText() ?? '';
    return xml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return '';
  }
}

const ALLOWED_TEMPLATE_VARS = new Set([
  'matter_ref', 'property_address', 'buyer_names', 'seller_names', 'exchange_date',
  'completion_date', 'counterparty_solicitor', 'counterparty_agent', 'lender',
  'track', 'stage', 'today', 'firm_name', 'assigned_to',
]);

/**
 * Defence-in-depth on AI-generated template text: cap size, strip control chars,
 * drop any {{placeholder}} that isn't on the allow-list, and remove [[AI blocks]]
 * when the plan can't run them. This runs after the model's structured output, so
 * even if a crafted description steered the model, the stored .docx stays bounded
 * and only references real matter variables.
 */
function sanitizeTemplateParagraphs(paragraphs: string[], allowAiBlocks: boolean): string[] {
  return (Array.isArray(paragraphs) ? paragraphs : [])
    .slice(0, 200)
    .map((p) => {
      let s = String(p ?? '').slice(0, 4000);
      s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ""); // strip control chars
      // Keep known {{vars}}, blank out unknown ones.
      s = s.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_m, name) => (ALLOWED_TEMPLATE_VARS.has(name) ? `{{${name}}}` : ''));
      if (!allowAiBlocks) s = s.replace(/\[\[[\s\S]*?\]\]/g, '');
      return s;
    });
}

/** True if both fill passes render without throwing (i.e. no unbalanced delimiters). */
export function templateRendersCleanly(content: Buffer): boolean {
  try {
    const d1 = new Docxtemplater(new PizZip(content), { delimiters: { start: '[[', end: ']]' }, paragraphLoop: true, linebreaks: true, nullGetter: () => '' });
    d1.render({});
    const mid = Buffer.from(d1.getZip().generate({ type: 'nodebuffer' }));
    const d2 = new Docxtemplater(new PizZip(mid), { delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true, nullGetter: () => '' });
    d2.render({});
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn a firm's natural-language description into a stored-ready .docx template.
 * The model only chooses CONTENT; we build the file, sanitise it, and guarantee it
 * fills cleanly (stripping any stray delimiters that would otherwise break fill).
 */
export async function generateDocTemplate(
  user: SessionUser,
  name: string,
  instructions: string,
  allowAiBlocks: boolean,
  source?: { fileName: string; bytes: Buffer }
): Promise<{ content: Buffer; fileName: string; hasLlmPrompts: boolean; description: string }> {
  // When an existing document is supplied, extract its text so the AI can turn it
  // into a template (preserving wording) rather than writing one from scratch.
  let sourceText = '';
  if (source) {
    if (/\.docx$/i.test(source.fileName)) sourceText = docxToText(source.bytes);
    else if (/\.txt$/i.test(source.fileName)) sourceText = source.bytes.toString('utf8');
    sourceText = sourceText.slice(0, 30000);
  }

  const { generateDocTemplateContent } = await import('./ai');
  const { paragraphs, description } = await generateDocTemplateContent({
    userId: user.userId,
    tenantId: user.tenantId,
    name,
    instructions,
    allowAiBlocks,
    sourceText: sourceText.trim() || undefined,
  });

  let finalParas = sanitizeTemplateParagraphs(paragraphs, allowAiBlocks);
  if (!finalParas.some((s) => s.trim())) {
    throw new Error('The AI returned an empty template — try a more specific description.');
  }
  let hasLlmPrompts = finalParas.some((s) => /\[\[[\s\S]+?\]\]/.test(s));
  let content = createMinimalDocx(finalParas);

  // If the model emitted unbalanced delimiters, neutralise them so per-matter fill
  // can never throw — at the cost of those placeholders in the worst case.
  if (!templateRendersCleanly(content)) {
    finalParas = finalParas.map((s) => s.replace(/\{\{|\}\}|\[\[|\]\]/g, ''));
    hasLlmPrompts = false;
    content = createMinimalDocx(finalParas);
  }

  return { content, fileName: templateOutputName(name), hasLlmPrompts, description };
}

export interface ExampleTemplate {
  name: string;
  description: string;
  fileName: string;
  paragraphs: string[];
  hasLlmPrompts: boolean;
}

export const EXAMPLE_TEMPLATES: ExampleTemplate[] = [
  {
    name: 'Client care letter',
    description: 'Introductory letter sent to clients at the start of a case.',
    fileName: 'client-care-letter.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}',
      '',
      '{{today}}',
      '',
      'Dear {{client_names}},',
      '',
      'RE: {{property_address}}   Our ref: {{matter_ref}}',
      '',
      'Thank you for instructing us on your {{transaction}} of the above property. ' +
        'We are pleased to act on your behalf and write to confirm the terms of our retainer.',
      '',
      'Your case is being handled by {{assigned_to}}. ' +
        'We aim to complete by {{completion_date}}, with exchange targeted for {{exchange_date}}.',
      '',
      'Please do not hesitate to contact us should you have any questions.',
      '',
      'Yours sincerely,',
      '',
      '{{assigned_to}}',
      '{{firm_name}}',
    ],
  },
  {
    name: 'Completion statement',
    description: 'Financial statement issued ahead of completion.',
    fileName: 'completion-statement.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}',
      '',
      'COMPLETION STATEMENT',
      '',
      'Case:       {{matter_ref}}',
      'Property:   {{property_address}}',
      'Client(s):  {{client_names}}',
      'Completion: {{completion_date}}',
      '',
      'FUNDS REQUIRED ON COMPLETION',
      '',
      'Purchase price:                             £[AMOUNT]',
      'Less deposit paid on exchange:             (£[DEPOSIT])',
      'Balance of purchase price:                  £[BALANCE]',
      '',
      'Solicitors fees (inc. VAT):                 £[FEES]',
      'Search fees:                                £[SEARCHES]',
      'Land Registry fee:                          £[LRFEE]',
      'SDLT / LTT:                                 £[SDLT]',
      '',
      'TOTAL FUNDS REQUIRED:                       £[TOTAL]',
      '',
      'Please send funds to arrive by 12:00 noon on {{completion_date}}.',
      '',
      'Lender: {{lender}}',
      'Counterparty solicitor: {{counterparty_solicitor}}',
      'Estate agent: {{counterparty_agent}}',
    ],
  },
  {
    name: 'Report on title',
    description: 'The report on title the client receives: the conveyancer-approved report goes where {{report_body}} is. Put your letterhead, logo and sign-off around it.',
    fileName: 'report-on-title.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}',
      '',
      'REPORT ON TITLE',
      '',
      'Case:      {{matter_ref}}',
      'Property:  {{property_address}}',
      'Client(s): {{client_names}}',
      'Date:      {{today}}',
      '',
      '{{report_body}}',
      '',
      'Prepared by: {{assigned_to}}',
      '{{firm_name}}',
    ],
  },
  {
    name: 'Deposit request letter',
    description: 'Asks the client for the exchange deposit once the contract is approved.',
    fileName: 'deposit-request-letter.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', '{{today}}', '', 'Dear {{client_names}},', '',
      'RE: {{property_address}}   Our ref: {{matter_ref}}', '',
      'We have approved the contract and are working towards exchange on {{exchange_date}}. To exchange we need the deposit of £[DEPOSIT] in cleared funds on our client account by [DATE].',
      '', 'Our client account details are set out below. We will never change these by email; if you receive a message asking you to pay elsewhere, telephone us on a number you already hold before doing anything.',
      '', '[CLIENT ACCOUNT DETAILS]', '',
      'Please send the funds from an account in your own name and let us know when they are on their way.',
      '', 'Yours sincerely,', '', '{{assigned_to}}', '{{firm_name}}',
    ],
  },
  {
    name: 'Exchange confirmation letter',
    description: 'Tells the client contracts have exchanged and what happens next.',
    fileName: 'exchange-confirmation-letter.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', '{{today}}', '', 'Dear {{client_names}},', '',
      'RE: {{property_address}}   Our ref: {{matter_ref}}', '',
      'We are pleased to confirm that contracts were exchanged today. Completion is fixed for {{completion_date}}.',
      '', 'From today you are legally bound to complete and the property is at your risk: please make sure buildings insurance is in place from now.',
      '', 'Before completion we will send you a completion statement showing the balance due. Funds must reach our client account by 12:00 noon on the working day before completion.',
      '', 'Yours sincerely,', '', '{{assigned_to}}', '{{firm_name}}',
    ],
  },
  {
    name: 'Completion letter',
    description: 'Confirms completion and sets out registration and the keys.',
    fileName: 'completion-letter.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', '{{today}}', '', 'Dear {{client_names}},', '',
      'RE: {{property_address}}   Our ref: {{matter_ref}}', '',
      'Congratulations: your purchase completed today. The keys can be collected from {{agent}}.',
      '', 'We will now pay the Stamp Duty Land Tax and apply to HM Land Registry to register you as the owner. Registration can take several weeks; we will send you the updated title when it arrives.',
      '', 'Yours sincerely,', '', '{{assigned_to}}', '{{firm_name}}',
    ],
  },
  {
    name: 'Contract pack covering letter',
    description: "Covers the draft contract and papers sent to the buyer's solicitor on a sale.",
    fileName: 'contract-pack-covering-letter.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', '{{today}}', '', '{{counterparty_solicitor}}', '', 'Dear Sirs,', '',
      'RE: {{property_address}}   Our ref: {{matter_ref}}   Seller: {{seller_names}}   Buyer: {{buyer_names}}', '',
      'We act for the seller. We enclose the draft contract in duplicate, official copies of the register and title plan, the Property Information Form (TA6) and the Fittings and Contents Form (TA10)[ and the Leasehold Information Form (TA7)].',
      '', 'Please let us have any enquiries in one batch. We look forward to hearing from you.',
      '', 'Yours faithfully,', '', '{{firm_name}}',
    ],
  },
  // ── A sale ──
  {
    name: 'Property forms letter',
    description: 'Sends the client the property forms to complete at the start of a sale.',
    fileName: 'property-forms-letter.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', '{{today}}', '', 'Dear {{client_names}},', '',
      'RE: Sale of {{property_address}}   Our ref: {{matter_ref}}', '',
      'To prepare the contract for your sale we need you to complete the enclosed Property Information Form (TA6) and Fittings and Contents Form (TA10)[, and the Leasehold Information Form (TA7)]. Please answer every question as fully as you can; "not known" is a proper answer where you genuinely do not know, but a wrong answer can lead to a claim after completion.',
      '', 'Please return them with copies of any planning permissions, building regulations completion certificates, guarantees and warranties (damp proofing, windows, roof), the boiler service record, and any FENSA or electrical certificates you hold.',
      '', "We cannot send the contract to the buyer's solicitor until they are back.",
      '', 'Yours sincerely,', '', '{{assigned_to}}', '{{firm_name}}',
    ],
  },
  {
    name: 'Replies to enquiries covering letter',
    description: "Covers our client's replies to the buyer's solicitor's enquiries on a sale.",
    fileName: 'replies-to-enquiries-letter.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', '{{today}}', '', '{{counterparty_solicitor}}', '', 'Dear Sirs,', '',
      'RE: {{property_address}}   Our ref: {{matter_ref}}   Seller: {{client_names}}   Buyer: {{other_names}}', '',
      "We enclose our client's replies to your enquiries, with the documents referred to. Our client's answers are given from their own knowledge and on the basis of the documents they hold.",
      '', 'Please confirm that you are now in a position to exchange, or let us have any further enquiries in one batch.',
      '', 'Yours faithfully,', '', '{{firm_name}}',
    ],
  },
  {
    name: 'Redemption statement request',
    description: "Asks the client's lender for the figure to pay off the mortgage (a sale or a remortgage).",
    fileName: 'redemption-statement-request.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', '{{today}}', '', '[LENDER NAME AND ADDRESS]', '', 'Dear Sirs,', '',
      'RE: {{property_address}}   Borrower(s): {{client_names}}   Account: [ACCOUNT NUMBER]   Our ref: {{matter_ref}}', '',
      'We act for your borrower(s) on the {{transaction}} of the above property. Please let us have a redemption statement for every charge you hold over it, calculated to {{completion_date}}, showing the daily rate of interest after that date and any early repayment charge.',
      '', "We enclose our client's signed authority to release this information to us.",
      '', 'Yours faithfully,', '', '{{firm_name}}',
    ],
  },
  {
    name: 'Exchange confirmation letter (sale)',
    description: 'Tells the seller contracts have exchanged and what they must do before completion.',
    fileName: 'exchange-confirmation-sale.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', '{{today}}', '', 'Dear {{client_names}},', '',
      'RE: Sale of {{property_address}}   Our ref: {{matter_ref}}', '',
      'We are pleased to confirm that contracts were exchanged today. Completion is fixed for {{completion_date}}, and from today you are legally bound to sell.',
      '', 'Before completion:',
      '• Arrange your removals so that the property is empty by 1pm on the completion date, leaving everything the Fittings and Contents Form says is included.',
      "• Leave every set of keys with {{counterparty_agent}}; they release them once we confirm the buyer's money has arrived.",
      '• Take final meter readings on the day and give them to your utility suppliers; tell your council tax office and insurer of the date.',
      '• Keep your buildings insurance in place until completion.',
      '', 'On completion we pay off your mortgage from the sale proceeds and send you the balance, with a completion statement showing every figure. We will need your bank details for that: we will take them by phone, never by email.',
      '', 'Yours sincerely,', '', '{{assigned_to}}', '{{firm_name}}',
    ],
  },
  {
    name: 'Completion statement (sale)',
    description: "The seller's statement of the sale money: the price, the mortgage paid off, fees and the balance to them.",
    fileName: 'completion-statement-sale.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', 'COMPLETION STATEMENT (SALE)', '',
      'Case:       {{matter_ref}}', 'Property:   {{property_address}}', 'Seller(s):  {{client_names}}', 'Completion: {{completion_date}}', '',
      'Sale price:                                 {{price}}',
      'Less deposit held on exchange:             (£[DEPOSIT])',
      'Balance received on completion:             £[BALANCE]',
      '',
      'Less: redemption of mortgage ({{lender}}):  (£[REDEMPTION])',
      "Less: estate agent's fee ({{counterparty_agent}}): (£[AGENT FEE])",
      'Less: our fees and disbursements (inc. VAT): (£[FEES])',
      '',
      'BALANCE DUE TO YOU:                          £[BALANCE TO CLIENT]',
      '', 'Sent to the account you gave us by phone, on the day of completion.',
    ],
  },
  {
    name: 'Completion letter (sale)',
    description: 'Confirms the sale has completed, the mortgage is paid off and the balance sent.',
    fileName: 'completion-letter-sale.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', '{{today}}', '', 'Dear {{client_names}},', '',
      'RE: Sale of {{property_address}}   Our ref: {{matter_ref}}', '',
      "Your sale completed today. The buyer's money has arrived and the estate agent has been told to release the keys.",
      '', "We have paid off your mortgage with {{lender}} and will send the lender's confirmation of discharge to HM Land Registry when it arrives. The balance due to you, shown on the enclosed completion statement, has been sent to your account.",
      '', 'This completes our work on your sale. Thank you for instructing us.',
      '', 'Yours sincerely,', '', '{{assigned_to}}', '{{firm_name}}',
    ],
  },
  // ── Signing ──
  {
    name: 'Signing pack covering letter',
    description: 'Sends the client the contract and deeds to sign, with how to sign and witness each.',
    fileName: 'signing-pack-letter.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', '{{today}}', '', 'Dear {{client_names}},', '',
      'RE: {{property_address}}   Our ref: {{matter_ref}}', '',
      'We enclose the documents you need to sign for your {{transaction}}: [the contract][, the transfer (TR1)][, the mortgage deed][, the declaration of trust].',
      '', 'The contract: sign where marked. It needs no witness. Do not date it: we date it when contracts are exchanged.',
      '', 'Each deed (the transfer, the mortgage deed, the declaration of trust): sign where marked in front of an independent adult witness, who must not be a relative, your partner or anyone with an interest in the property. The witness signs and prints their name and address. Do not date them.',
      '', 'Please post the signed originals to us at the address above. Your lender will not release the mortgage money until we hold the signed mortgage deed.',
      '', 'Yours sincerely,', '', '{{assigned_to}}', '{{firm_name}}',
    ],
  },
  // ── A remortgage ──
  {
    name: 'Completion statement (remortgage)',
    description: 'The remortgage statement: the new advance, the old mortgage paid off, fees, and any balance either way.',
    fileName: 'completion-statement-remortgage.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', 'COMPLETION STATEMENT (REMORTGAGE)', '',
      'Case:        {{matter_ref}}', 'Property:    {{property_address}}', 'Borrower(s): {{client_names}}', 'Completion:  {{completion_date}}', '',
      'Advance from {{lender}}:                     £[ADVANCE]',
      'Less: redemption of existing mortgage:     (£[REDEMPTION])',
      'Less: our fees and disbursements (inc. VAT): (£[FEES])',
      'Less: HM Land Registry fee:                 (£[LR FEE])',
      '',
      'BALANCE [DUE TO YOU / DUE FROM YOU]:         £[BALANCE]',
      '', 'Any balance due from you must reach our client account as cleared funds two working days before completion.',
    ],
  },
  {
    name: 'Completion letter (remortgage)',
    description: 'Confirms the remortgage has completed and the old mortgage is paid off.',
    fileName: 'completion-letter-remortgage.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', '{{today}}', '', 'Dear {{client_names}},', '',
      'RE: Remortgage of {{property_address}}   Our ref: {{matter_ref}}', '',
      'Your remortgage completed today. Your new lender, {{lender}}, released the advance and we have used it to pay off your previous mortgage, as shown on the enclosed completion statement.',
      '', "We will now register your new lender's charge at HM Land Registry and have the old one removed. We will write when registration is complete.",
      '', 'Yours sincerely,', '', '{{assigned_to}}', '{{firm_name}}',
    ],
  },
  // ── A transfer of equity ──
  {
    name: 'Lender consent request',
    description: 'Asks the lender to consent to a transfer of equity of a mortgaged property.',
    fileName: 'lender-consent-request.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', '{{today}}', '', '[LENDER NAME AND ADDRESS]', '', 'Dear Sirs,', '',
      'RE: {{property_address}}   Borrower(s): {{client_names}}   Account: [ACCOUNT NUMBER]   Our ref: {{matter_ref}}', '',
      'We act for your borrower(s) on a transfer of equity of the above property: [the transfer to be made and to whom]. Please confirm your consent, and let us know any conditions (a deed of covenant, a new mortgage deed, or a release of the outgoing borrower) and the documents you require.',
      '', 'Yours faithfully,', '', '{{firm_name}}',
    ],
  },
  {
    name: 'Completion letter (transfer of equity)',
    description: 'Confirms the transfer has completed and what happens with registration and SDLT.',
    fileName: 'completion-letter-transfer.docx',
    hasLlmPrompts: false,
    paragraphs: [
      '{{firm_name}}', '', '{{today}}', '', 'Dear {{client_names}},', '',
      'RE: Transfer of equity of {{property_address}}   Our ref: {{matter_ref}}', '',
      'The transfer of the above property completed today.',
      '', 'We will now file any Stamp Duty Land Tax return due and apply to HM Land Registry to register the new ownership. We will send you the updated title when registration is complete.',
      '', 'Yours sincerely,', '', '{{assigned_to}}', '{{firm_name}}',
    ],
  },
];

/** Where each standard document is produced in the flow and who receives it. Matched by name; a firm's own upload with the same name inherits it. */
export const DOC_USAGE: Record<string, { step: string; to: string }> = {
  'Client care letter': { step: 'Instruction, once the case is enrolled', to: 'Client' },
  'Deposit request letter': { step: 'Contract & Exchange, once the contract is approved', to: 'Client' },
  'Exchange confirmation letter': { step: 'Contract & Exchange, on exchange', to: 'Client' },
  'Completion statement': { step: 'Completion, after exchange', to: 'Client' },
  'Completion letter': { step: 'Completion, when completion is confirmed', to: 'Client' },
  'Contract pack covering letter': { step: 'Contract, when the pack goes out on a sale', to: "Buyer's solicitor" },
  'Property forms letter': { step: 'Instruction, on a sale', to: 'Client' },
  'Replies to enquiries covering letter': { step: 'Enquiries, when the replies go on a sale', to: "Buyer's solicitor" },
  'Redemption statement request': { step: 'Instruction, on a sale or remortgage of a mortgaged property', to: 'Lender' },
  'Exchange confirmation letter (sale)': { step: 'Contract & Exchange, on exchange (sale)', to: 'Client' },
  'Completion statement (sale)': { step: 'Completion, after exchange (sale)', to: 'Client' },
  'Completion letter (sale)': { step: 'Completion, when completion is confirmed (sale)', to: 'Client' },
  'Signing pack covering letter': { step: 'Signing, once the contract is approved', to: 'Client' },
  'Completion statement (remortgage)': { step: 'Completion, before the advance is drawn (remortgage)', to: 'Client' },
  'Completion letter (remortgage)': { step: 'Completion, when completion is confirmed (remortgage)', to: 'Client' },
  'Lender consent request': { step: 'Instruction, on a transfer of equity of a mortgaged property', to: 'Lender' },
  'Completion letter (transfer of equity)': { step: 'Completion, when completion is confirmed (transfer of equity)', to: 'Client' },
  'Report on title': { step: 'Title, once the title is resolved (interim) or everything is in; a conveyancer approves it, and it goes as this Word document with the report where {{report_body}} is', to: 'Client' },
};

/**
 * The approved report on title as a Word document for the client: the firm's own "Report on title"
 * template (its letterhead and branding) with the report where it says {{report_body}}; a clean
 * document with the case heading when the firm's template has no such place. The approved words go
 * in as they are: nothing here writes or rewrites them.
 */
export async function renderReportOnTitleDocx(tenantId: string, matterId: string, body: string): Promise<{ bytes: Buffer; fileName: string }> {
  const user = { tenantId, userId: '' } as SessionUser;
  const { vars, matterRef } = await loadMatterVars(user, matterId);
  const fileName = `Report on title - ${matterRef}.docx`;
  const tpl = await queryOne<{ file_content: Buffer }>(`select file_content from doc_template where tenant_id = $1 and name = 'Report on title' order by created_at limit 1`, [tenantId]).catch(() => null);
  if (tpl?.file_content) {
    const xml = new PizZip(Buffer.from(tpl.file_content)).file('word/document.xml')?.asText() ?? '';
    // docxtemplater may have split the tag across runs: look at the text alone.
    if (/\{\{\s*report_body\s*\}\}/.test(xml.replace(/<[^>]+>/g, ''))) {
      const doc = new Docxtemplater(new PizZip(Buffer.from(tpl.file_content)), { delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true, nullGetter: () => '' });
      doc.render({ ...vars, report_body: body.replace(/\r\n/g, '\n').trim() });
      return { bytes: Buffer.from(doc.getZip().generate({ type: 'nodebuffer' })), fileName };
    }
  }
  const heading = [vars.firm_name, '', 'REPORT ON TITLE', '', `Case: ${vars.matter_ref}`, `Property: ${vars.property_address}`, `Client(s): ${vars.buyer_names}`, `Date: ${vars.today}`, ''].filter((l, i, all) => l || all[i - 1]);
  return { bytes: createMinimalDocx([...heading, ...body.replace(/\r\n/g, '\n').trim().split('\n')]), fileName };
}
