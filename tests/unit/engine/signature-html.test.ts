/** A pasted signature keeps its formatting and loses anything that could run or leak. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSignatureHtml as clean } from '../../../lib/server/html-sanitize';
import { buildSignature } from '../../../lib/server/signature';

test('formatting, tables, links and images survive', () => {
  const out = clean('<table cellpadding="0"><tr><td style="color:#333;font-weight:bold"><a href="https://firm.co.uk" target="x">Firm</a><br><img src="https://firm.co.uk/logo.png" alt="Logo" width="80"></td></tr></table>');
  assert.match(out, /<table cellpadding="0"><tr><td style="color:#333;font-weight:bold"><a href="https:\/\/firm.co.uk" target="_blank" rel="noopener noreferrer">Firm<\/a><br><img src="https:\/\/firm.co.uk\/logo.png" alt="Logo" width="80"><\/td><\/tr><\/table>/);
});

test('scripts, handlers, unsafe links, styles blocks and unknown tags are removed', () => {
  const out = clean('<div onclick="x()">Hi<script>alert(1)</script><style>body{}</style><a href="javascript:alert(1)">bad</a><img src="x" onerror="alert(1)"><iframe src="https://e.vil"></iframe><svg><circle/></svg><span style="background:url(javascript:1);color:red">ok</span><custom>t</custom></div>');
  assert.ok(!/script|onclick|onerror|javascript|iframe|svg|<style|custom/i.test(out), out);
  assert.match(out, /<div>Hi<a>bad<\/a><img><span style="color:red">ok<\/span>t<\/div>/);
});

test('stray angle brackets in text are escaped and unclosed tags are closed', () => {
  assert.equal(clean('<b>1 < 2 > 0'), '<b>1 &lt; 2 &gt; 0</b>');
});

test("a person's pasted signature replaces the standard one; the firm's notice still goes under it", () => {
  const firm = { name: 'Smith & Co', addressLine1: null, addressLine2: null, town: null, postcode: null, phone: null, sraNumber: '123', website: null, signatureNotice: 'We never change bank details by email.' };
  const s = buildSignature(firm, { name: 'Jo', jobTitle: null, phone: null, email: null, signatureHtml: '<b>Jo Bloggs</b><br>Partner<script>x</script>' });
  assert.match(s.html, /<b>Jo Bloggs<\/b><br>Partner/);
  assert.ok(!/script/.test(s.html));
  assert.match(s.html, /never change bank details/);
  assert.ok(!/SRA number/.test(s.html), 'the standard block is not added as well');
});
