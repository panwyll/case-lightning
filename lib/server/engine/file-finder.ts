/**
 * A file on the case found by what someone calls it ("my TA10", "the survey", "the mortgage offer"),
 * and its bytes, so it can go back to the client as an attachment. Only the case's own filed papers;
 * never the engine's notes, dossiers or drafts.
 */
import { query, queryOne } from '../db';
import { getBlob } from '../blob-store';

const INTERNAL = ['FILE_NOTE', 'EMAIL', 'ESCALATION_DOSSIER', 'DEADLINE_DOSSIER', 'PROPOSAL', 'BANK_DETAILS_NOTE', 'SANDBOX_EMAIL', 'REPORT_ON_TITLE_DRAFT'];
/** What people call a document, to the words its type or name carries. */
/** Each alias: what the words mean, what they map to, and (optionally) a more specific phrase it must not swallow ("report on title" is not the title). */
const ALIASES: Array<[RegExp, string[], RegExp?]> = [
  [/\bta ?6\b|property information/i, ['TA6', 'property information', 'property_forms']],
  [/\bta ?10\b|fittings/i, ['TA10', 'fittings']],
  [/\bta ?7\b|leasehold information/i, ['TA7', 'leasehold']],
  [/survey|homebuyer|valuation/i, ['survey', 'SURVEY']],
  [/mortgage offer|\boffer\b/i, ['MORTGAGE_OFFER', 'offer']],
  [/contract/i, ['CONTRACT', 'contract'], /report on (the )?contract/i],
  [/title|register|official cop/i, ['TITLE', 'OFFICIAL_COPY', 'register'], /report on (the )?title|certificate of title/i],
  [/search|local authority|drainage|environmental/i, ['SEARCH', 'search']],
  [/report on title/i, ['report on title']],
  [/completion statement/i, ['COMPLETION_STATEMENT', 'completion statement']],
  [/lease\b/i, ['LEASE', 'lease']],
  [/epc|energy performance/i, ['EPC']],
  [/management pack|lpe1/i, ['MANAGEMENT_PACK', 'LPE1']],
];

export async function findFiles(tenantId: string, matterId: string, what: string): Promise<Array<{ id: string; fileName: string }>> {
  // "my report on title" is looked for as "report on title".
  const bare = what.trim().replace(/^(the|my|our|a|a copy of( the| my| our)?)\s+/i, '');
  const words = [...new Set([bare, ...ALIASES.filter(([re, , not]) => re.test(what) && !not?.test(what)).flatMap(([, w]) => w)])].filter((w) => w.length >= 2).slice(0, 8);
  if (!words.length) return [];
  const rows = await query<{ id: string; file_name: string | null; doc_type: string | null; score: number }>(
    `select id, file_name, doc_type,
            (select count(*) from unnest($3::text[]) w where coalesce(file_name, '') ilike '%' || w || '%' or coalesce(doc_type, '') ilike '%' || w || '%' or coalesce(extracted_facts->>'role', '') ilike '%' || w || '%')::int as score
       from document
      where tenant_id = $1 and matter_id = $2 and superseded_at is null and coalesce(doc_type, '') <> all($4::text[])
      order by score desc, created_at desc limit 20`,
    [tenantId, matterId, words, INTERNAL]
  ).catch(() => []);
  const hits = rows.filter((r) => r.score > 0);
  if (!hits.length) return [];
  const top = hits[0].score;
  return hits.filter((r) => r.score === top).slice(0, 3).map((r) => ({ id: r.id, fileName: r.file_name ?? 'Document' }));
}

export async function fileBytes(tenantId: string, id: string): Promise<{ name: string; bytes: Buffer; contentType: string } | null> {
  const d = await queryOne<{ file_name: string | null; mime_type: string | null; doc_type: string | null; matter_id: string; content: string | null; blob: Buffer | null }>(`select file_name, mime_type, doc_type, matter_id, extracted_facts->>'content' as content, (select b.bytes from document_blob b where b.document_id = d.id) as blob from document d where d.id = $1 and d.tenant_id = $2`, [id, tenantId]).catch(() => null);
  if (!d) return null;
  // The report on title goes again as it went: the Word document rendered from the approved text.
  if (d.doc_type === 'REPORT_ON_TITLE_DRAFT' && d.content) {
    const { renderReportOnTitleDocx } = await import('../doc-templates');
    const out = await renderReportOnTitleDocx(tenantId, d.matter_id, d.content);
    return { name: out.fileName, bytes: out.bytes, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  const bytes = d.blob ?? (await getBlob(tenantId, id).catch(() => null));
  return bytes ? { name: d.file_name ?? 'Document', bytes, contentType: d.mime_type ?? 'application/octet-stream' } : null;
}
