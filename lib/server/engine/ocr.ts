/**
 * OCR (Document Review Engine, part 5): page text for scans, so quote verification and
 * the coverage ledger work on documents with no text layer. A PDF page is rendered with
 * pdf.js onto a Node canvas and read by Tesseract; an image is read directly. Only pages
 * with no usable text are OCR'd; the model still reads the original file.
 *
 * Everything here is lazy and best-effort: a missing native canvas or a failed OCR leaves
 * the page as "no text layer", never fails the read.
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export interface OcrPage { text: string; confidence: number }

const require = createRequire(import.meta.url);

type Worker = { recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>; terminate(): Promise<unknown> };
/** Two Tesseract workers per process: a long scan reads two pages at a time. Started on first use; language data cached under /tmp. */
const POOL = 2;
const workers: Array<Promise<Worker> | null> = Array.from({ length: POOL }, () => null);
async function worker(slot = 0): Promise<Worker> {
  const i = slot % POOL;
  if (!workers[i]) {
    const p = (async () => {
      const { createWorker } = require('tesseract.js') as { createWorker: (lang: string, oem?: number, opts?: Record<string, unknown>) => Promise<Worker> };
      return createWorker('eng', 1, { cachePath: process.env.TESSERACT_CACHE ?? os.tmpdir(), logger: () => {} });
    })();
    workers[i] = p;
    p.catch(() => { workers[i] = null; });
  }
  return workers[i]!;
}

/** Stop the workers (tests, and a graceful shutdown); the next OCR starts fresh ones. */
export async function terminateOcr(): Promise<void> {
  const ps = workers.splice(0, POOL, ...Array.from({ length: POOL }, () => null));
  await Promise.all(ps.map((p) => p?.then((w) => w.terminate()).catch(() => {})));
}

export async function ocrImage(png: Buffer, slot = 0): Promise<OcrPage> {
  const w = await worker(slot);
  const r = await w.recognize(png);
  return { text: r.data.text.replace(/\s+\n/g, '\n').trim(), confidence: Math.round(r.data.confidence) };
}

/**
 * Render the given pages of a PDF (1-based) and OCR them, two at a time, until `budgetMs` has gone (a
 * page started is finished). Pages not reached come back missing: the ledger shows them without text.
 */
export async function ocrPdfPages(bytes: Buffer, pages: number[], opts: { scale?: number; maxPages?: number; budgetMs?: number } = {}): Promise<Map<number, OcrPage>> {
  const out = new Map<number, OcrPage>();
  if (!pages.length) return out;
  const { createCanvas } = require('@napi-rs/canvas') as { createCanvas: (w: number, h: number) => { width: number; height: number; getContext(k: '2d'): unknown; toBuffer(t: 'image/png'): Buffer } };
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fontDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, standardFontDataUrl: fontDir }).promise;
  const want = pages.filter((p) => p >= 1 && p <= doc.numPages).slice(0, opts.maxPages ?? 300);
  const until = Date.now() + (opts.budgetMs ?? 90_000);
  let next = 0;
  // Rendering is serial (one pdf.js document); recognition runs on POOL workers side by side.
  const render = async (p: number): Promise<Buffer> => {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: opts.scale ?? 2 });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx as never, viewport: vp, canvas: canvas as never }).promise;
    return canvas.toBuffer('image/png');
  };
  let rendering = Promise.resolve();
  const lane = async (slot: number) => {
    while (next < want.length && Date.now() < until) {
      const p = want[next++];
      try {
        let png!: Buffer;
        const mine = rendering.then(async () => { png = await render(p); });
        rendering = mine.catch(() => {});
        await mine;
        out.set(p, await ocrImage(png, slot));
      } catch {
        /* this page stays without text */
      }
    }
  };
  await Promise.all(Array.from({ length: POOL }, (_, i) => lane(i)));
  await (doc as unknown as { cleanup?: () => Promise<void> }).cleanup?.().catch(() => {});
  return out;
}
