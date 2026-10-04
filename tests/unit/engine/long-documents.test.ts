/**
 * Long documents and tables (sections.ts, review.ts layoutLines, pg-documents htmlToLines): a long PDF
 * is cut into even sections and the readings merged with the pages of the whole document; a table's
 * cells stay apart, from a PDF or a Word document.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeReadings, pdfFirstPages, pdfSections, shiftPages } from '../../../lib/server/engine/sections';
import { layoutLines } from '../../../lib/server/engine/review';
import { htmlToLines } from '../../../lib/server/engine/pg-documents';

async function blankPdf(pages: number): Promise<string> {
  const m = await import('mupdf');
  const doc = new m.PDFDocument();
  for (let i = 0; i < pages; i++) doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, doc.newDictionary(), ''));
  return Buffer.from(doc.saveToBuffer('').asUint8Array()).toString('base64');
}
const pagesOf = async (b64: string) => { const m = await import('mupdf'); return m.Document.openDocument(Buffer.from(b64, 'base64'), 'application/pdf').countPages(); };

test('a PDF over 80 pages is cut into even sections that cover every page once', async () => {
  assert.equal(await pdfSections(await blankPdf(40)), null, 'short enough to read whole');
  const secs = (await pdfSections(await blankPdf(130)))!;
  // At most 60 a section, and even: 130 pages is 44 + 44 + 42, not 60 + 60 + 10.
  assert.deepEqual(secs.map((s) => [s.firstPage, s.lastPage]), [[1, 44], [45, 88], [89, 130]]);
  assert.deepEqual(await Promise.all(secs.map((s) => pagesOf(s.data))), [44, 44, 42]);
  assert.ok(secs.every((s) => s.total === 130));
  const three = (await pdfSections(await blankPdf(170)))!;
  assert.deepEqual(three.map((s) => [s.firstPage, s.lastPage]), [[1, 57], [58, 114], [115, 170]]);
  assert.equal(await pagesOf(await pdfFirstPages(await blankPdf(130), 3)), 3);
});

test("a section's pages are moved to the whole document's, and the readings merge into one", () => {
  const second = shiftPages({ clauses: [{ code: 'repair', text: 'The Tenant repairs the interior', locator: { page: 4, quote: 'repairs' } }], pages: [{ page: 1, verdict: 'facts' }], termYears: 125 }, 65);
  assert.equal(second.clauses[0].locator.page, 69);
  assert.equal(second.pages[0].page, 66);
  assert.equal(second.termYears, 125, 'only page numbers move');
  type Reading = { landlord: string; termYears: number | null; groundRentPenniesPa: number | null; clauses: Array<{ code: string; text: string }>; flags: Array<{ code: string; text: string }>; pages: Array<{ page: number; verdict: string }>; confidence: number; scanQuality: string; forfeitureClause: boolean };
  const merged = mergeReadings<Reading>([
    { landlord: 'Acme Estates Ltd', termYears: 125, groundRentPenniesPa: null, clauses: [{ code: 'alienation', text: 'No assignment of part' }], flags: [], pages: [{ page: 1, verdict: 'facts' }], confidence: 0.9, scanQuality: 'good', forfeitureClause: false },
    { landlord: 'Someone Else', termYears: null, groundRentPenniesPa: 25_000, clauses: [{ code: 'alienation', text: 'No assignment of part' }, { code: 'repair', text: 'The Tenant repairs the interior' }], flags: [{ code: 'DOUBLING_RENT', text: 'Rent doubles every 25 years' }], pages: [{ page: 66, verdict: 'facts' }], confidence: 0.7, scanQuality: 'fair', forfeitureClause: true },
  ]);
  assert.equal(merged.landlord, 'Acme Estates Ltd', 'the first section to state a single value wins');
  assert.equal(merged.termYears, 125);
  assert.equal(merged.groundRentPenniesPa, 25_000, 'a value only a later section states is kept');
  assert.deepEqual(merged.clauses.map((c) => c.code), ['alienation', 'repair'], 'a clause read twice is kept once');
  assert.equal(merged.flags.length, 1);
  assert.deepEqual(merged.pages.map((p) => p.page), [1, 66]);
  assert.equal(merged.confidence, 0.7, 'the lowest confidence');
  assert.equal(merged.scanQuality, 'fair', 'the worst scan');
  assert.equal(merged.forfeitureClause, true, 'a yes from any section stands');
});

test("a PDF table's cells stay apart, and words on a line join as written", () => {
  const it = (str: string, x: number, y: number, w: number) => ({ str, x, y, w, h: 10, eol: false });
  const text = layoutLines([
    it('Date', 50, 700, 22), it('Description', 150, 700, 55), it('Amount', 400, 700, 35),
    it('02/09', 50, 685, 25), it('Salary', 150, 685, 30), it('2,450.00', 400, 685, 40),
    it('The Ten', 50, 600, 38), it('ant shall', 88, 600, 40), it('repair', 131, 600, 30),
  ]);
  assert.equal(text, 'Date | Description | Amount\n02/09 | Salary | 2,450.00\nThe Tenant shall repair');
});

test('a Word table comes through as rows of cells', () => {
  const html = '<h1>Schedule</h1><p>Fixtures &amp; fittings</p><table><tr><td><p>Item</p></td><td><p>Price</p></td></tr><tr><td>Curtains</td><td>£300</td></tr></table><ul><li>Carpets stay</li></ul>';
  assert.equal(htmlToLines(html), 'Schedule\nFixtures & fittings\nItem | Price\nCurtains | £300\nCarpets stay');
});

test("a page's text comes back whole from its overlapping chunks (for reading the pages OCR did not reach)", async () => {
  const { chunks } = await import('../../../lib/server/engine/file-index');
  const { joinChunks } = await import('../../../lib/server/engine/file-backfill');
  const page = Array.from({ length: 50 }, (_, i) => `${i + 1}. The Tenant covenants to keep the Flat in repair and to pay the rent on the due dates without deduction.`).join('\n');
  const parts = chunks(page);
  assert.ok(parts.length > 2);
  assert.equal(joinChunks(parts), page);
  assert.equal(joinChunks([]), '');
  assert.equal(joinChunks(['Only chunk.']), 'Only chunk.');
});
