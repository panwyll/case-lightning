/**
 * Import matters from a case management system's CSV export.
 *
 * A firm already running LEAP, Osprey, Proclaim or similar has an authoritative
 * matter list; the backlog scan can only infer one from whatever is still active in
 * the mailbox. Exporting to CSV is something every one of those systems can do, and
 * it needs no API, no partner programme and no permission from a vendor who may
 * regard us as a competitor.
 *
 * The reference column is the valuable part. It lands in matter.firm_ref, so from
 * then on email matches on the firm's own reference and every audit row we write
 * reconciles against their case file — the connection people assume needs an
 * integration, achieved with a file.
 *
 * Deliberately forgiving about headers (every vendor names them differently) and
 * deliberately strict about what it will create: a row needs a reference or an
 * address, and anything already present is skipped rather than duplicated.
 */
import { query } from './db';
import { createMatter } from './matter';
import type { SessionUser } from './types';

export interface ImportRow {
  /** 1-based line number in the file, for error messages that mean something. */
  line: number;
  firmRef: string;
  propertyAddress: string;
  buyerNames: string[];
  sellerNames: string[];
  counterpartySolicitor?: string;
  counterpartyAgent?: string;
  exchangeTargetDate?: string;
  completionTargetDate?: string;
  /** Why this row won't be imported, when it won't. */
  skip?: string;
}

export interface ImportPreview {
  rows: ImportRow[];
  importable: number;
  skipped: number;
  /** Header → the field we mapped it to, so the user can see what we understood. */
  mapping: Record<string, string>;
  unmapped: string[];
}

/** Hard cap: an import is a setup step, not a bulk data pipeline. */
export const MAX_IMPORT_ROWS = 500;

// Header synonyms, lower-cased and stripped of punctuation. Ordered so the more
// specific match wins (a "client name" column is a buyer, not a generic name).
const FIELD_SYNONYMS: Array<[keyof ImportRow, string[]]> = [
  ['firmRef', ['matterref', 'matterreference', 'fileref', 'filereference', 'ourref', 'reference', 'ref', 'matterno', 'matternumber', 'fileno', 'filenumber', 'caseref', 'casenumber', 'matterid']],
  ['propertyAddress', ['propertyaddress', 'property', 'address', 'addressline1', 'subjectproperty', 'premises', 'situate']],
  ['buyerNames', ['buyer', 'buyers', 'buyername', 'buyernames', 'purchaser', 'purchasers', 'client', 'clientname', 'clients']],
  ['sellerNames', ['seller', 'sellers', 'sellername', 'sellernames', 'vendor', 'vendors']],
  ['counterpartySolicitor', ['othersidesolicitor', 'otherside', 'counterparty', 'counterpartysolicitor', 'oppositesolicitor', 'otherssolicitor', 'solicitor', 'oppositeparty']],
  ['counterpartyAgent', ['agent', 'estateagent', 'counterpartyagent', 'sellingagent']],
  ['exchangeTargetDate', ['exchange', 'exchangedate', 'targetexchange', 'exchangetargetdate', 'anticipatedexchange']],
  ['completionTargetDate', ['completion', 'completiondate', 'targetcompletion', 'completiontargetdate', 'anticipatedcompletion']],
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * RFC-4180-ish CSV parser: quoted fields, embedded commas and newlines, doubled
 * quotes. Hand-rolled rather than adding a dependency for one setup screen — and a
 * naive split(',') mangles "Smith, John" and any address with a comma in it, which
 * is most of them.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, ''); // strip BOM — Excel loves one
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Split a cell holding several people ("A Smith; B Smith" / "A & B Smith"). */
function names(cell: string): string[] {
  if (!cell?.trim()) return [];
  return cell
    .split(/[;|]| and | & |\//i)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
}

/** Dates arrive in every format; keep ISO, convert UK d/m/y, else leave it out. */
function isoDate(cell: string): string | undefined {
  const s = (cell ?? '').trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const uk = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (uk) {
    const [, d, m, y] = uk;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

/**
 * Map a parsed CSV to rows we could create, marking (not dropping) the ones we
 * won't. Showing a skipped row and why beats silently importing 40 of 50.
 */
export async function previewImport(user: SessionUser, csv: string): Promise<ImportPreview> {
  const table = parseCsv(csv);
  if (!table.length) return { rows: [], importable: 0, skipped: 0, mapping: {}, unmapped: [] };

  const header = table[0].map((h) => h.trim());
  const mapping: Record<string, string> = {};
  const colFor: Partial<Record<keyof ImportRow, number>> = {};
  const unmapped: string[] = [];
  header.forEach((h, i) => {
    const n = norm(h);
    const hit = FIELD_SYNONYMS.find(([field, syns]) => syns.includes(n) && colFor[field] === undefined);
    if (hit) {
      colFor[hit[0]] = i;
      mapping[h] = hit[0];
    } else if (h) unmapped.push(h);
  });

  const cell = (r: string[], f: keyof ImportRow) => {
    const i = colFor[f];
    return i === undefined ? '' : (r[i] ?? '').trim();
  };

  // Everything already here, so a re-import doesn't duplicate. Both our own ref and
  // any firm ref we've learned or previously imported count as "already present".
  const existing = new Set<string>();
  try {
    const rows = await query<{ matter_ref: string; firm_ref: string | null }>(
      `select matter_ref, firm_ref from matter where tenant_id = $1`,
      [user.tenantId]
    );
    for (const r of rows) {
      if (r.matter_ref) existing.add(r.matter_ref.toUpperCase());
      if (r.firm_ref) existing.add(r.firm_ref.toUpperCase());
    }
  } catch {
    const rows = await query<{ matter_ref: string }>(`select matter_ref from matter where tenant_id = $1`, [user.tenantId]);
    for (const r of rows) if (r.matter_ref) existing.add(r.matter_ref.toUpperCase());
  }

  const seen = new Set<string>();
  const rows: ImportRow[] = table.slice(1, MAX_IMPORT_ROWS + 1).map((r, idx) => {
    const firmRef = cell(r, 'firmRef');
    const propertyAddress = cell(r, 'propertyAddress');
    const row: ImportRow = {
      line: idx + 2, // +1 for the header, +1 for 1-based
      firmRef,
      propertyAddress,
      buyerNames: names(cell(r, 'buyerNames')),
      sellerNames: names(cell(r, 'sellerNames')),
      counterpartySolicitor: cell(r, 'counterpartySolicitor') || undefined,
      counterpartyAgent: cell(r, 'counterpartyAgent') || undefined,
      exchangeTargetDate: isoDate(cell(r, 'exchangeTargetDate')),
      completionTargetDate: isoDate(cell(r, 'completionTargetDate')),
    };
    const key = (firmRef || propertyAddress).toUpperCase();
    if (!firmRef && !propertyAddress) row.skip = 'No reference or property address';
    else if (existing.has(firmRef.toUpperCase())) row.skip = 'Already imported';
    else if (seen.has(key)) row.skip = 'Duplicate row in this file';
    else seen.add(key);
    return row;
  });

  return {
    rows,
    importable: rows.filter((r) => !r.skip).length,
    skipped: rows.filter((r) => r.skip).length,
    mapping,
    unmapped,
  };
}

export interface ImportOutcome {
  created: number;
  failed: Array<{ line: number; firmRef: string; error: string }>;
}

/**
 * Create the importable rows. Each becomes a normal matter — same OneDrive folder
 * and tracker as any other — with firm_ref set to the firm's own reference so
 * matching and the audit trail speak their language from the first email.
 *
 * One at a time on purpose: each createMatter provisions M365 surfaces, and firing
 * hundreds in parallel would rate-limit Graph and blow the request budget. The
 * caller slices.
 */
export async function runImport(user: SessionUser, rows: ImportRow[]): Promise<ImportOutcome> {
  const out: ImportOutcome = { created: 0, failed: [] };
  for (const row of rows) {
    if (row.skip) continue;
    try {
      const created = await createMatter(user, {
        matterRef: row.firmRef,
        propertyAddress: row.propertyAddress,
        buyerNames: row.buyerNames,
        sellerNames: row.sellerNames,
        counterpartySolicitor: row.counterpartySolicitor,
        counterpartyAgent: row.counterpartyAgent,
        exchangeTargetDate: row.exchangeTargetDate,
        completionTargetDate: row.completionTargetDate,
      });
      // Record THEIR reference, not the (possibly suffixed) one we settled on.
      if (row.firmRef) {
        await query(`update matter set firm_ref = $3 where id = $1 and tenant_id = $2`, [
          created.id,
          user.tenantId,
          row.firmRef,
        ]).catch(() => {});
      }
      out.created += 1;
    } catch (error) {
      out.failed.push({ line: row.line, firmRef: row.firmRef, error: (error as Error).message });
    }
  }
  return out;
}
