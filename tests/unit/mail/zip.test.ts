/** A zip on an email is opened and each file inside is filed on its own; clutter and hostile archives are bounded. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { expandZip, isZip, MAX_FILES } from '../../../lib/server/zip-expand';

const zipOf = async (files: Record<string, string | Buffer>) => { const z = new JSZip(); for (const [k, v] of Object.entries(files)) z.file(k, v); return z.generateAsync({ type: 'nodebuffer' }); };

test('files inside are extracted with their names and types; folders and system clutter are skipped', async () => {
  const buf = await zipOf({ 'Pack/TA6.pdf': '%PDF-1.4 x', 'Pack/TA10.docx': 'x', '__MACOSX/Pack/._TA6.pdf': 'x', '.DS_Store': 'x', 'Pack/Thumbs.db': 'x' });
  assert.ok(isZip('pack.zip', null, buf));
  const r = await expandZip(buf);
  assert.equal(r.error, null);
  assert.deepEqual(r.entries.map((e) => [e.name, e.contentType]).sort(), [['TA10.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['TA6.pdf', 'application/pdf']]);
});

test('a zip inside a zip is opened one level down', async () => {
  const inner = await zipOf({ 'search.pdf': '%PDF-1.4 y' });
  const r = await expandZip(await zipOf({ 'searches.zip': inner, 'title.pdf': '%PDF-1.4 z' }));
  assert.deepEqual(r.entries.map((e) => e.name).sort(), ['search.pdf', 'title.pdf']);
});

test('an archive with too many files keeps the first ones and says why the rest were left', async () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < MAX_FILES + 5; i++) many[`f${i}.txt`] = String(i);
  const r = await expandZip(await zipOf(many));
  assert.equal(r.entries.length, MAX_FILES);
  assert.equal(r.skipped.length, 5);
});

test('something that is not a zip says it could not be opened', async () => {
  const r = await expandZip(Buffer.from('PK\u0003\u0004 not really a zip'));
  assert.match(r.error ?? '', /could not be opened/);
});
