/**
 * Component #3 — the AI reasoning layer, harnessed.
 *
 *   raw document → extraction (#2) → structured facts → DETERMINISTIC rules → verdict
 *                                                            │
 *                                    (only when the verdict is "flag")
 *                                                            ▼
 *                       this module: read + summarise + draft, citing the source
 *
 * The model's job is reading, summarising and drafting. It never makes the final
 * decision: the verdict, the flags, the citations and the option set are fixed by
 * rules.ts before the model is asked anything, and every output here is checked by
 * a VALIDATOR before it is allowed to replace the deterministic template prose:
 *
 *   - a decision summary must mention every flag (by code or by its locator quote),
 *     must not introduce figures/dates that are not in the facts, and must not give
 *     the answer ("approve"/"reject") — the human decides;
 *   - a report on title must be built only from sections that cite a known source
 *     document; a section without a citation is dropped and the draft is marked
 *     incomplete so the approving conveyancer sees the gap.
 *
 * Anything that fails validation falls back to the template (mocks.ts) — the engine
 * keeps moving, the handler still sees a correct, source-cited decision.
 */
import { z } from 'zod/v4';
import type { Citation, DecisionKind, Flag, MatterState } from './types';
import type { DecisionSummariser, DocumentRef, ReportDrafter } from './ports';
import type { EngineDocumentInput, StructuredLlm } from './llm';
import type { DocumentBytesLoader } from './extraction';
import { OPTIONS_FOR, optionLabel } from './rules';
import { TemplateReportDrafter } from './mocks';
import type { SummaryOverride } from './machine';

// ───────────────────────────── decision summaries ─────────────────────────────

const SummarySchema = z.object({
  headline: z.string().describe('One sentence: what needs deciding and why it matters. No recommendation.'),
  findings: z
    .array(
      z.object({
        code: z.string().describe('The flag code this paragraph explains — must be one of the codes given.'),
        explanation: z.string().describe('2–4 sentences in plain English: what the source says (quote it), what this typically means in a purchase, what is usually done about it. State facts, not advice.'),
      })
    )
    .describe('Exactly one entry per flag, in the order given.'),
  whatToCheckInSource: z.string().describe('Where in the document the handler should look before deciding (pages/sections).'),
});

const SUMMARY_INSTRUCTIONS =
  'You write the pre-digested briefing a case handler reads before deciding on a flagged item in a residential freehold purchase. ' +
  'You are given the deterministic flags (already decided by rules — do not add, remove or re-grade them) and the source document. ' +
  'Explain each flag in plain English for a busy conveyancer: what the source actually says (quote the words), what it typically means, ' +
  'and what is usually done about it. Never recommend which option to choose, never say "approve" or "reject", never invent figures, ' +
  'dates, references or clauses that are not in the material. Facts only; the human decides.';

/** Digits with 3+ characters, £ amounts, and ISO-ish dates — the things a model might hallucinate. */
const FIGURE_RE = /£\s?[\d,]+(?:\.\d+)?|\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{3,}\b/g;

const figuresIn = (s: string): Set<string> => new Set((s.match(FIGURE_RE) ?? []).map((m) => m.replace(/[\s,]/g, '').toLowerCase()));

export interface SummaryValidation {
  ok: boolean;
  problems: string[];
}

/**
 * The harness: does the model's summary respect the flags and the facts? Pure, so it
 * is unit-tested against adversarial outputs.
 */
export function validateSummary(flags: Flag[], allowedText: string, out: z.infer<typeof SummarySchema>): SummaryValidation {
  const problems: string[] = [];
  const codes = new Set(flags.map((f) => f.code));
  const seen = new Set(out.findings.map((f) => f.code.trim().toUpperCase()));
  for (const c of codes) if (!seen.has(c)) problems.push(`flag ${c} not explained`);
  for (const f of out.findings) if (!codes.has(f.code.trim().toUpperCase())) problems.push(`unknown flag ${f.code}`);
  const text = [out.headline, out.whatToCheckInSource, ...out.findings.map((f) => f.explanation)].join('\n');
  if (/\b(you should|we recommend|i recommend|approve this|reject this|choose to|best option is)\b/i.test(text)) problems.push('summary gives a recommendation');
  // Every figure/date in the prose must appear in the allowed material (flags + facts + quotes).
  const allowed = figuresIn(allowedText);
  for (const fig of figuresIn(text)) if (!allowed.has(fig)) problems.push(`figure "${fig}" not in the source facts`);
  if (out.findings.some((f) => f.explanation.trim().length < 40)) problems.push('an explanation is too thin');
  return { ok: problems.length === 0, problems };
}

/** Render the validated structured summary into the prose the dashboard shows. */
export function renderSummary(kind: DecisionKind, subjectLabel: string, flags: Flag[], out: z.infer<typeof SummarySchema>): string {
  const byCode = new Map(out.findings.map((f) => [f.code.trim().toUpperCase(), f.explanation.trim()]));
  const lines = [`${subjectLabel}: ${out.headline.trim()}`, ''];
  flags.forEach((f, i) => {
    const where = f.locator ? ` (see ${f.locator.page ? `p.${f.locator.page}` : 'source'}${f.locator.section ? `, ${f.locator.section}` : ''})` : '';
    lines.push(`${i + 1}. [${f.severity.toUpperCase()}] ${f.description}${where}`);
    lines.push(`   ${byCode.get(f.code) ?? ''}`);
  });
  lines.push('', `Check in the source: ${out.whatToCheckInSource.trim()}`);
  lines.push(`Options: ${OPTIONS_FOR[kind].map(optionLabel).join(' · ')}.`);
  return lines.join('\n');
}

export class ClaudeSummariser implements DecisionSummariser {
  readonly name: string;
  constructor(
    private llm: StructuredLlm,
    private loader: DocumentBytesLoader,
    private opts: { model: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; log?: (msg: string, detail?: unknown) => void } = { model: 'claude-opus-5' }
  ) {
    this.name = `claude-summariser:${opts.model}`;
  }

  async summarise(input: { kind: DecisionKind; subjectLabel: string; flags: Flag[]; source: DocumentRef; state: MatterState }): Promise<SummaryOverride | null> {
    const source = await this.loader.load(input.source).catch(() => null);
    const documents: EngineDocumentInput[] = source ? [{ ...source, title: input.source.fileName ?? input.source.id }] : [];
    const flagText = input.flags.map((f, i) => `${i + 1}. code=${f.code} severity=${f.severity} — ${f.description}${f.locator ? ` [p.${f.locator.page ?? '?'}${f.locator.section ? ` ${f.locator.section}` : ''}${f.locator.quote ? ` "${f.locator.quote}"` : ''}]` : ''}`).join('\n');
    const facts = JSON.stringify(factsFor(input.kind, input.state));
    try {
      const res = await this.llm.call({
        schema: SummarySchema,
        instructions: SUMMARY_INSTRUCTIONS,
        documents,
        prompt: `Decision kind: ${input.kind}. Subject: ${input.subjectLabel}. Matter stage: ${input.state.stage}.\n\nFLAGS (fixed — explain each, do not change them):\n${flagText}\n\nEXTRACTED FACTS (DATA):\n${facts}\n\nWrite the briefing.`,
        model: this.opts.model,
        effort: this.opts.effort ?? 'high',
        maxTokens: 4000,
        meter: { tenantId: input.state.tenantId, matterId: input.state.matterId, feature: 'DECISION_SUMMARY' },
      });
      const v = validateSummary(input.flags, `${flagText}\n${facts}`, res.output);
      if (!v.ok) {
        this.opts.log?.(`summary rejected by validator — using template (${v.problems.join('; ')})`);
        return null;
      }
      return { text: renderSummary(input.kind, input.subjectLabel, input.flags, res.output), by: res.model };
    } catch (err) {
      this.opts.log?.('summariser call failed — using template', err);
      return null;
    }
  }
}

/** The facts the summary may draw figures from (also what the validator allows). */
function factsFor(kind: DecisionKind, s: MatterState): unknown {
  switch (kind) {
    case 'mortgage':
      return s.mortgage.facts;
    case 'title':
      return s.title.facts;
    case 'search':
      return Object.values(s.searches).map((x) => x.facts).filter(Boolean);
    default:
      return null;
  }
}

// ───────────────────────────── report on title ─────────────────────────────

const ReportSchema = z.object({
  sections: z.array(
    z.object({
      heading: z.string(),
      body: z.string().describe('Client-facing plain English. Say what the document shows and what it means for the buyer. No legal advice beyond standard explanation; flag anything the conveyancer must confirm as "[CONVEYANCER TO CONFIRM]".'),
      sourceDocumentIds: z.array(z.string()).describe('Ids of the documents this section is drawn from — must be from the list given. Empty only for the introduction.'),
    })
  ),
  outstanding: z.array(z.string()).describe('Points the conveyancer must resolve or confirm before this report is sent.'),
});

const REPORT_INSTRUCTIONS =
  'You draft the report on title a buyer receives before exchange in a residential freehold purchase in England & Wales. ' +
  'Write for the client: clear headings, plain English, no jargon without explanation. Cover: the property and title, ' +
  'covenants/restrictions/charges, each search and what it found, enquiries and their replies, the mortgage offer and any special conditions, ' +
  'and what happens next (exchange, deposit, completion). Every substantive section must cite the source documents it is drawn from by id. ' +
  'Where a fact is missing or the extraction was uncertain, write "[CONVEYANCER TO CONFIRM]" rather than filling the gap. ' +
  'This is a DRAFT that a conveyancer will approve; never state that it has been sent or that it is final.';

export class ClaudeReportDrafter implements ReportDrafter {
  readonly name: string;
  private fallback = new TemplateReportDrafter();
  constructor(
    private llm: StructuredLlm,
    private opts: { model: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; log?: (msg: string, detail?: unknown) => void } = { model: 'claude-opus-5' }
  ) {
    this.name = `claude-report-drafter:${opts.model}`;
  }

  async draft(input: { state: MatterState; documents: DocumentRef[] }) {
    const { state, documents } = input;
    const known = new Map(documents.map((d) => [d.id, d]));
    const docList = documents.map((d) => `- id=${d.id} type=${d.docType ?? 'unknown'} file=${d.fileName ?? ''}`).join('\n');
    const facts = {
      title: state.title.facts,
      searches: Object.values(state.searches).map((s) => ({ searchType: s.searchType, status: s.status, resolution: s.resolution, documentId: s.documentId, facts: s.facts })),
      enquiries: Object.values(state.enquiries).map((q) => ({ enquiryId: q.enquiryId, subject: q.subject, status: q.status, resolution: q.resolution, documentId: q.documentId })),
      mortgage: state.hasLender ? { status: state.mortgage.status, documentId: state.mortgage.documentId, facts: state.mortgage.facts } : 'cash purchase',
      targetExchangeDate: state.targetExchangeDate,
      targetCompletionDate: state.targetCompletionDate,
    };
    try {
      const res = await this.llm.call({
        schema: ReportSchema,
        instructions: REPORT_INSTRUCTIONS,
        prompt: `SOURCE DOCUMENTS (cite by id):\n${docList}\n\nCLEARED / REVIEWED FACTS (DATA):\n${JSON.stringify(facts)}\n\nDraft the report on title.`,
        model: this.opts.model,
        effort: this.opts.effort ?? 'high',
        maxTokens: 12_000,
        meter: { tenantId: state.tenantId, matterId: state.matterId, feature: 'REPORT_DRAFT' },
      });
      const { content, citations, dropped } = assembleReport(res.output, known);
      if (!citations.length) {
        this.opts.log?.('report draft cited no known documents — using template');
        return this.fallback.draft(input);
      }
      const gaps = [...res.output.outstanding, ...dropped.map((h) => `Section "${h}" was dropped: it cited no known source document.`)];
      return {
        content,
        summary:
          `AI-drafted report on title from ${citations.length} source document(s)` +
          (gaps.length ? `. ${gaps.length} point(s) for you to resolve before approving:\n- ${gaps.join('\n- ')}` : '. Check every section against its source before approving.'),
        citations,
        model: res.model,
        basedOn: citations.map((c) => c.documentId),
      };
    } catch (err) {
      this.opts.log?.('report drafter failed — using template', err);
      return this.fallback.draft(input);
    }
  }
}

/** Keep only sections whose citations are real; the citations become the decision's citations. */
export function assembleReport(out: z.infer<typeof ReportSchema>, known: Map<string, DocumentRef>): { content: string; citations: Citation[]; dropped: string[] } {
  const lines: string[] = ['REPORT ON TITLE (DRAFT — requires conveyancer approval before sending)', ''];
  const cited = new Map<string, Citation>();
  const dropped: string[] = [];
  out.sections.forEach((s, i) => {
    const ids = s.sourceDocumentIds.filter((id) => known.has(id));
    if (i > 0 && ids.length === 0) {
      dropped.push(s.heading);
      return;
    }
    lines.push(s.heading.toUpperCase(), s.body.trim(), ids.length ? `Sources: ${ids.map((id) => known.get(id)?.fileName ?? id).join('; ')}` : '', '');
    for (const id of ids) if (!cited.has(id)) cited.set(id, { documentId: id, label: `${known.get(id)?.docType ?? 'Document'}: ${known.get(id)?.fileName ?? id}` });
  });
  if (out.outstanding.length) lines.push('POINTS FOR THE CONVEYANCER TO CONFIRM', ...out.outstanding.map((o) => `- ${o}`), '');
  return { content: lines.join('\n'), citations: [...cited.values()], dropped };
}

export { SummarySchema, ReportSchema };
