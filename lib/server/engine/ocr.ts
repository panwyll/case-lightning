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
let workerPromise: Promise<Worker> | null = null;
/** One Tesseract worker per process, started on first use; language data is cached under /tmp so serverless hosts can write it. */
async function worker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = require('tesseract.js') as { createWorker: (lang: string, oem?: number, opts?: Record<string, unknown>) => Promise<Worker> };
      return createWorker('eng', 1, { cachePath: process.env.TESSERACT_CACHE ?? os.tmpdir(), logger: () => {} });
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

/** Stop the worker (tests, and a graceful shutdown); the next OCR starts a fresh one. */
export async function terminateOcr(): Promise<void> {
  const p = workerPromise;
  workerPromise = null;
  if (p) await p.then((w) => w.terminate()).catch(() => {});
}

export async function ocrImage(png: Buffer): Promise<OcrPage> {
  const w = await worker();
  const r = await w.recognize(png);
  return { text: r.data.text.replace(/\s+\n/g, '\n').trim(), confidence: Math.round(r.data.confidence) };
}

/** Render the given pages of a PDF (1-based) and OCR them. Pages not listed come back untouched (null). */
export async function ocrPdfPages(bytes: Buffer, pages: number[], opts: { scale?: number; maxPages?: number } = {}): Promise<Map<number, OcrPage>> {
  const out = new Map<number, OcrPage>();
  if (!pages.length) return out;
  const { createCanvas } = require('@napi-rs/canvas') as { createCanvas: (w: number, h: number) => { width: number; height: number; getContext(k: '2d'): unknown; toBuffer(t: 'image/png'): Buffer } };
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fontDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, standardFontDataUrl: fontDir }).promise;
  const want = pages.filter((p) => p >= 1 && p <= doc.numPages).slice(0, opts.maxPages ?? 60);
  for (const p of want) {
    try {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: opts.scale ?? 2 });
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx as never, viewport: vp, canvas: canvas as never }).promise;
      out.set(p, await ocrImage(canvas.toBuffer('image/png')));
    } catch {
      /* this page stays without text */
    }
  }
  await (doc as unknown as { cleanup?: () => Promise<void> }).cleanup?.().catch(() => {});
  return out;
}
