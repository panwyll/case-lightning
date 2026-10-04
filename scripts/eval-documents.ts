/**
 * The document eval: ten realistic conveyancing documents (tests/eval/fixtures), read by the real
 * pipeline with the real models, scored against what a conveyancer reads in them (tests/eval/expected.ts).
 *
 *   classification  — each document read as the right kind
 *   facts           — the register holds each expected fact, with the right value
 *   citations       — key facts cited to the right page; quotes verified against the page text
 *   ask             — each question finds the right document (and page) and answers it, or says the
 *                     file does not say
 *
 * Runs against the LOCAL database only (it writes a case "EVAL-FILE" to it) and needs ANTHROPIC_API_KEY.
 *   npm run eval:docs                       # everything
 *   npm run eval:docs -- --only 02-lease    # one document (and no questions)
 * Results go to tests/eval/results/<date>.json, and a summary to the console.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { query, queryOne } from '../lib/server/db';
import { config } from '../lib/server/config';
import { claudeLlm } from '../lib/server/engine/llm';
import { ClaudeExtractor } from '../lib/server/engine/extraction';
import { PgDocumentBytesLoader, PgDocumentFactsWriter } from '../lib/server/engine/pg-documents';
import { askFile } from '../lib/server/engine/file-ask';
import { terminateOcr } from '../lib/server/engine/ocr';
import type { DocumentRef } from '../lib/server/engine/ports';
import type { SearchType } from '../lib/server/engine/types';
import { DOCUMENTS, QUESTIONS, type FactCheck } from '../tests/eval/expected';

const ROOT = path.join(__dirname, '..', 'tests', 'eval');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

function pdfFor(file: string): Buffer {
  const out = path.join(ROOT, 'pdfs', `${file}.pdf`);
  if (!fs.existsSync(out)) {
    execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${out}`, `file://${path.join(ROOT, 'fixtures', `${file}.html`)}`], { stdio: 'ignore' });
  }
  return fs.readFileSync(out);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
type Row = { key: string; value: string; page: number | null; verified: boolean; note: string | null };
function check(c: FactCheck, rows: Row[]): { ok: boolean; pageOk: boolean | null; got: string } {
  const hits = rows.filter((r) => (c.prefix ? r.key.startsWith(c.key) : r.key === c.key));
  if (!hits.length) return { ok: c.not != null, pageOk: null, got: '(missing)' };
  const good = hits.find((r) =>
    c.eq != null ? norm(r.value) === norm(c.eq)
    : c.num != null ? Number(r.value) === c.num
    : c.has ? c.has.test(r.value)
    : c.not != null ? norm(r.value) !== norm(c.not)
    : true);
  const shown = hits.map((r) => r.value.slice(0, 80)).join(' | ');
  if (!good) return { ok: false, pageOk: null, got: shown };
  return { ok: true, pageOk: c.page == null ? null : good.page === c.page, got: good.value.slice(0, 80) };
}

async function main() {
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  const url = process.env.DATABASE_URL ?? '';
  if (!/(@|\/\/)(localhost|127\.0\.0\.1)([:/]|$)/.test(url)) throw new Error('The eval writes to the database: point DATABASE_URL at the local one (npm run dev:db).');
  const tenant = (await queryOne<{ id: string }>(`select id from tenant order by created_at limit 1`))!.id;
  const user = (await queryOne<{ id: string }>(`select id from app_user where tenant_id = $1 order by created_at limit 1`, [tenant]))!.id;
  let matter = (await queryOne<{ id: string }>(`select id from matter where tenant_id = $1 and matter_ref = 'EVAL-FILE'`, [tenant]))?.id;
  if (!matter) matter = (await queryOne<{ id: string }>(`insert into matter (tenant_id, matter_ref, property_address, created_by) values ($1, 'EVAL-FILE', '14 Oak Street, Leeds LS1 2AB (eval)', $2) returning id`, [tenant, user]))!.id;
  // A fresh file each run: the documents (and their pages, facts and index rows) from the last one go.
  // (with --only, just that document's earlier copies)
  const old = await query<{ id: string }>(`select id from document where matter_id = $1 and ($2::text is null or file_name = $2)`, [matter, only ? `${only}.pdf` : null]);
  if (old.length) {
    const ids = old.map((o) => o.id);
    await query(`delete from kb_chunk where source_id = any($1::uuid[])`, [ids]);
    await query(`delete from document_fact where document_id = any($1::uuid[])`, [ids]);
    await query(`delete from document_page where document_id = any($1::uuid[])`, [ids]);
    await query(`delete from document_blob where document_id = any($1::uuid[])`, [ids]);
    await query(`delete from document where id = any($1::uuid[])`, [ids]);
  }

  const llm = claudeLlm();
  const ex = new ClaudeExtractor(llm, new PgDocumentBytesLoader(), new PgDocumentFactsWriter(), { model: config.engineExtractModel, classifyModel: config.engineClassifyModel, criticalModel: config.engineCriticalModel });
  const startedAt = Date.now();
  const docs: Array<Record<string, unknown>> = [];
  const idOf: Record<string, string> = {};
  for (const d of DOCUMENTS.filter((x) => !only || x.file === only)) {
    const bytes = pdfFor(d.file);
    const row = (await queryOne<{ id: string }>(`insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type) values ($1, $2, 'UPLOAD', $3, $4, 'application/pdf') returning id`, [tenant, matter, `eval/${d.file}.pdf`, `${d.file}.pdf`]))!;
    await query(`insert into document_blob (document_id, tenant_id, bytes, storage_path, size_bytes) values ($1, $2, $3, $4, $5)`, [row.id, tenant, bytes, `eval/${d.file}.pdf`, bytes.length]);
    idOf[d.file] = row.id;
    const ref: DocumentRef = { id: row.id, tenantId: tenant, matterId: matter, docType: null, fileName: `${d.file}.pdf`, webUrl: null, extractedFacts: null, extractionConfidence: null };
    const t0 = Date.now();
    let role = '(failed)', error: string | null = null;
    try { role = (await ex.classify(ref)).role; } catch (e) { error = `classify: ${(e as Error).message}`; }
    try {
      switch (d.extract) {
        case 'title': await ex.extractTitle(ref); break;
        case 'lease': await ex.extractLease(ref); break;
        case 'contract': await ex.extractContract(ref); break;
        case 'mortgage': await ex.extractMortgageOffer(ref); break;
        case 'search': await ex.extractSearch(ref, d.searchType as SearchType); break;
        case 'property_forms': await ex.extractPropertyForms(ref); break;
        case 'management_pack': await ex.extractManagementPack(ref); break;
        case 'supporting_document': await ex.extractSupportingDocument(ref); break;
        case 'survey': await ex.extractSurvey(ref); break;
        case 'id_check': await ex.extractIdCheck(ref); break;
      }
    } catch (e) { error = `${error ? `${error}; ` : ''}extract: ${(e as Error).message}`; }
    const rows = await query<Row>(`select key, value, page, verified, note from document_fact where document_id = $1`, [row.id]);
    const checks = d.facts.map((c) => ({ why: c.why, key: c.key, ...check(c, rows) }));
    const quoted = rows.filter((r) => r.note !== 'stated without a quote' && r.note !== 'no quote');
    docs.push({
      file: d.file, expectedRole: d.role, role, roleOk: role === d.role, seconds: Math.round((Date.now() - t0) / 1000), error,
      facts: { expected: checks.length, found: checks.filter((c) => c.ok).length }, checks,
      pages: { expected: checks.filter((c) => c.pageOk != null).length, right: checks.filter((c) => c.pageOk === true).length },
      register: { rows: rows.length, verified: rows.filter((r) => r.verified).length, quoted: quoted.length, quotedVerified: quoted.filter((r) => r.verified).length },
    });
    process.stdout.write(`${d.file}: ${role === d.role ? 'kind ok' : `KIND ${role} (expected ${d.role})`}, ${checks.filter((c) => c.ok).length}/${checks.length} facts${error ? `, ERROR ${error}` : ''}\n`);
  }

  const asks: Array<Record<string, unknown>> = [];
  if (!only) {
    for (const q of QUESTIONS) {
      const t0 = Date.now();
      const r = await askFile(tenant, matter, q.q, { llm });
      const text = (r.answer ?? []).filter((s) => s.supported).map((s) => s.text).join(' ');
      const wantDoc = q.file ? idOf[q.file] : null;
      const found = wantDoc ? r.sources.some((s) => s.documentId === wantDoc && (q.page == null || s.page === q.page)) : null;
      const answered = q.answer.length ? !r.notOnFile && q.answer.every((re) => re.test(text)) : r.notOnFile || !text;
      asks.push({ q: q.q, why: q.why, found, answered, notOnFile: r.notOnFile, unsupported: (r.answer ?? []).filter((s) => !s.supported).map((s) => `${s.text} (${s.why})`), answer: text.slice(0, 400), sources: r.sources.map((s) => `${s.id} ${s.label}`), seconds: Math.round((Date.now() - t0) / 1000) });
      process.stdout.write(`ask: ${q.q} → ${found === false ? 'WRONG SOURCE, ' : ''}${answered ? 'answered' : 'NOT ANSWERED'}\n`);
    }
  }

  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);
  const D = docs as Array<{ roleOk: boolean; facts: { expected: number; found: number }; pages: { expected: number; right: number }; register: { quoted: number; quotedVerified: number; rows: number; verified: number } }>;
  const A = asks as Array<{ found: boolean | null; answered: boolean; unsupported: string[] }>;
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 100);
  const summary = {
    at: new Date().toISOString(),
    models: { classify: config.engineClassifyModel, extract: config.engineExtractModel, critical: config.engineCriticalModel, qa: config.engineQaModel },
    embeddings: !!(config.voyageApiKey || config.openAiApiKey),
    minutes: Math.round((Date.now() - startedAt) / 6000) / 10,
    classification: `${D.filter((d) => d.roleOk).length}/${D.length}`,
    factRecall: `${pct(sum(D, (d) => d.facts.found), sum(D, (d) => d.facts.expected))}% (${sum(D, (d) => d.facts.found)}/${sum(D, (d) => d.facts.expected)})`,
    citationPages: `${sum(D, (d) => d.pages.right)}/${sum(D, (d) => d.pages.expected)}`,
    quotesVerified: `${pct(sum(D, (d) => d.register.quotedVerified), sum(D, (d) => d.register.quoted))}% of quoted facts`,
    registerVerified: `${pct(sum(D, (d) => d.register.verified), sum(D, (d) => d.register.rows))}% of all facts`,
    askRetrieval: A.length ? `${A.filter((a) => a.found !== false).length}/${A.length}` : null,
    askAnswered: A.length ? `${A.filter((a) => a.answered).length}/${A.length}` : null,
    askUnsupportedSentences: sum(A, (a) => a.unsupported.length),
  };
  const out = path.join(ROOT, 'results', `${summary.at.slice(0, 16).replace(/[:T]/g, '-')}${only ? `-${only}` : ''}.json`);
  fs.writeFileSync(out, JSON.stringify({ summary, documents: docs, questions: asks }, null, 2));
  console.log('\n' + JSON.stringify(summary, null, 2));
  for (const d of docs as Array<{ file: string; checks: Array<{ ok: boolean; pageOk: boolean | null; why: string; got: string }> }>) for (const c of d.checks) if (!c.ok || c.pageOk === false) console.log(`MISS ${d.file}: ${c.why}${c.pageOk === false ? ' (wrong page)' : ''} — got ${c.got}`);
  console.log(`\nWritten: ${path.relative(process.cwd(), out)}`);
}

main().then(() => terminateOcr()).then(() => process.exit(0)).catch(async (e) => { console.error(e); await terminateOcr(); process.exit(1); });
