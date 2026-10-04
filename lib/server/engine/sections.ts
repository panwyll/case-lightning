/**
 * Long documents read in sections. A model takes a PDF of at most 100 pages, and a 150-page lease in
 * one call either fails or skims; over SPLIT_OVER pages the document is cut into sections of at most
 * SECTION pages, each section read with the same instructions, page numbers shifted back to the whole
 * document, and the readings merged into one.
 *
 * The merge is generic over the extraction schemas: lists are joined (a clause found twice is kept
 * once), the first section to state a single value wins (parties, dates, the term are near the front),
 * a yes from any section stands, confidence is the lowest, scan quality the worst.
 */
export const SPLIT_OVER = 80;
export const SECTION = 60;

export interface PdfSection { data: string; firstPage: number; lastPage: number; total: number }

/** The PDF's sections, or null when it is short enough to read whole (or cannot be cut). */
export async function pdfSections(base64: string, opts: { over?: number; size?: number } = {}): Promise<PdfSection[] | null> {
  const over = opts.over ?? SPLIT_OVER, size = opts.size ?? SECTION;
  try {
    const m = await import('mupdf');
    const src = m.Document.openDocument(Buffer.from(base64, 'base64'), 'application/pdf') as import('mupdf').PDFDocument;
    const total = src.countPages();
    if (total <= over) return null;
    const out: PdfSection[] = [];
    // Even sections, at most SECTION each (a 130-page lease is 44 + 44 + 42, not 60 + 60 + 10).
    const n = Math.ceil(total / size);
    const each = Math.ceil(total / n);
    for (let first = 0; first < total; first += each) {
      const last = Math.min(total, first + each) - 1;
      const part = new m.PDFDocument();
      for (let p = first; p <= last; p++) part.graftPage(-1, src, p);
      out.push({ data: Buffer.from(part.saveToBuffer('compress').asUint8Array()).toString('base64'), firstPage: first + 1, lastPage: last + 1, total });
    }
    return out;
  } catch {
    return null; // unreadable by mupdf: read it whole and let the model say what it can
  }
}

/** The opening pages of a PDF as a PDF (what a scanned document is, from its first pages); the whole file when it is that short or cannot be cut. */
export async function pdfFirstPages(base64: string, n: number): Promise<string> {
  try {
    const m = await import('mupdf');
    const src = m.Document.openDocument(Buffer.from(base64, 'base64'), 'application/pdf') as import('mupdf').PDFDocument;
    if (src.countPages() <= n) return base64;
    const part = new m.PDFDocument();
    for (let p = 0; p < n; p++) part.graftPage(-1, src, p);
    return Buffer.from(part.saveToBuffer('compress').asUint8Array()).toString('base64');
  } catch {
    return base64;
  }
}

/** Every `page` number in a reading, moved by `offset` (a section's page 1 is the document's page firstPage). */
export function shiftPages<T>(value: T, offset: number): T {
  if (!offset) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k === 'page' && typeof x === 'number' ? x + offset : walk(x)]));
    return v;
  };
  return walk(value) as T;
}

const SCAN_ORDER = ['good', 'fair', 'poor', 'unreadable'];
const empty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const key = (v: unknown) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    // The same clause or flag read twice (in the overlap of two answers) is one: by code and text, not by where.
    if ('code' in o || 'text' in o) return JSON.stringify([o.code ?? null, typeof o.text === 'string' ? o.text.trim().toLowerCase().slice(0, 200) : null, o.topic ?? null]);
    if ('page' in o && 'verdict' in o) return `page:${o.page}`;
  }
  return JSON.stringify(v);
};

/** Readings of the sections of one document, as one reading. */
export function mergeReadings<T>(parts: T[]): T {
  const merge = (a: unknown, b: unknown, field?: string): unknown => {
    if (empty(a)) return b;
    if (empty(b)) return a;
    if (field === 'confidence' && typeof a === 'number' && typeof b === 'number') return Math.min(a, b);
    if (field === 'scanQuality' && typeof a === 'string' && typeof b === 'string') return SCAN_ORDER.indexOf(b) > SCAN_ORDER.indexOf(a) ? b : a;
    if (field === 'pageCount' && typeof a === 'number' && typeof b === 'number') return a + b;
    if (Array.isArray(a) && Array.isArray(b)) {
      const seen = new Set(a.map(key));
      return [...a, ...b.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; })];
    }
    if (typeof a === 'boolean' && typeof b === 'boolean') return a || b;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
      for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = merge(out[k], v, k);
      return out;
    }
    return a; // a single value: the first section to state it
  };
  return parts.reduce((acc, p) => merge(acc, p) as T);
}
