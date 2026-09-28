/**
 * A file on the case found by what someone calls it ("my TA10", "the survey", "the mortgage offer"),
 * and its bytes, so it can go back to the client as an attachment. Only the case's own filed papers;
 * never the engine's notes, dossiers or drafts.
 */
import { query, queryOne } from '../db';
import { getBlob } from '../blob-store';

const INTERNAL = ['FILE_NOTE', 'EMAIL', 'ESCALATION_DOSSIER', 'DEADLINE_DOSSIER', 'PROPOSAL', 'BANK_DETAILS_NOTE', 'SANDBOX_EMAIL', 'REPORT_ON_TITLE_DRAFT'];
/** What people call a document, to the words its type or name carries. */
const ALIASES: Array<[RegExp, string[]]> = [
  [/\bta ?6\b|property information/i, ['TA6', 'property information', 'property_forms']],
  [/\bta ?10\b|fittings/i, ['TA10', 'fittings']],
  [/\bta ?7\b|leasehold information/i, ['TA7', 'leasehold']],
  [/survey|homebuyer|valuation/i, ['survey', 'SURVEY']],
  [/mortgage offer|offer/i, ['MORTGAGE_OFFER', 'offer']],
  [/contract/i, ['CONTRACT', 'contract']],
  [/title|register|official cop/i, ['TITLE', 'OFFICIAL_COPY', 'register']],
  [/search|local authority|drainage|environmental/i, ['SEARCH', 'search']],
  [/report on title/i, ['report on title']],
  [/completion statement/i, ['COMPLETION_STATEMENT', 'completion statement']],
  [/lease\b/i, ['LEASE', 'lease']],
  [/epc|energy performance/i, ['EPC']],
  [/management pack|lpe1/i, ['MANAGEMENT_PACK', 'LPE1']],
];

export async function findFiles(tenantId: string, matterId: string, what: string): Promise<Array<{ id: string; fileName: string }>> {
  const words = [...new Set([what.trim(), ...ALIASES.filter(([re]) => re.test(what)).flatMap(([, w]) => w)])].filter((w) => w.length >= 2).slice(0, 8);
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
  const d = await queryOne<{ file_name: string | null; mime_type: string | null; blob: Buffer | null }>(`select file_name, mime_type, (select b.bytes from document_blob b where b.document_id = d.id) as blob from document d where d.id = $1 and d.tenant_id = $2`, [id, tenantId]).catch(() => null);
  if (!d) return null;
  const bytes = d.blob ?? (await getBlob(tenantId, id).catch(() => null));
  return bytes ? { name: d.file_name ?? 'Document', bytes, contentType: d.mime_type ?? 'application/octet-stream' } : null;
}
