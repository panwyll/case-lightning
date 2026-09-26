import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pageTextsWithOcr, verifyQuote } from '../../../lib/server/engine/review';
import { terminateOcr } from '../../../lib/server/engine/ocr';

const require = createRequire(import.meta.url);

/** A "scan": text drawn as pixels, no text layer. Skipped where the native canvas is not installed. */
function scan(text: string): Buffer | null {
  try {
    const { createCanvas } = require('@napi-rs/canvas');
    const c = createCanvas(900, 220);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 900, 220);
    ctx.fillStyle = '#000'; ctx.font = '48px sans-serif'; ctx.fillText(text, 30, 130);
    return c.toBuffer('image/png');
  } catch {
    return null;
  }
}

test('a scanned image is OCR\'d so its quotes can be verified, and the ledger knows it came from OCR', { timeout: 120_000 }, async (t) => {
  const png = scan('REGISTERED CHARGE dated 1 March 2019');
  if (!png) return t.skip('native canvas not available here');
  t.after(() => terminateOcr());
  const texts = await pageTextsWithOcr({ kind: 'image', data: png.toString('base64') });
  assert.equal(texts.textLayer, true, 'OCR produced text');
  assert.ok((texts.ocr?.[0] ?? 0) > 50, `OCR confidence ${texts.ocr?.[0]}`);
  const v = verifyQuote('registered charge dated 1 march 2019', 1, texts);
  assert.equal(v.verified, true);
  assert.match(v.note ?? '', /OCR/);
});
