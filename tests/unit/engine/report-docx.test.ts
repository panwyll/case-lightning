import { test } from 'node:test';
import assert from 'node:assert/strict';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { createMinimalDocx } from '../../../lib/server/doc-templates';
import { docxText } from '../../../lib/server/doc-generate';

test("the firm's report on title template takes the approved report where it says {{report_body}}, line by line, around its own letterhead", () => {
  const tpl = createMinimalDocx(['ACME CONVEYANCING LTD', 'Report for {{buyer_names}}', '{{report_body}}', 'Yours sincerely']);
  const doc = new Docxtemplater(new PizZip(tpl), { delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true, nullGetter: () => '' });
  doc.render({ buyer_names: 'Priya Shah', report_body: 'THE PROPERTY\nFreehold.\n\nSEARCHES\nAll clear.' });
  const text = docxText(Buffer.from(doc.getZip().generate({ type: 'nodebuffer' })));
  assert.match(text, /ACME CONVEYANCING LTD/);
  assert.match(text, /Report for Priya Shah/);
  assert.match(text, /THE PROPERTY\nFreehold\.\n\nSEARCHES\nAll clear\./);
  assert.match(text, /Yours sincerely/);
});
