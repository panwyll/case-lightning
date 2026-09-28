/** The rulebook is the machine's own rules in plain words: every section filled, stable ids, and the firm's settings included. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulebook, RULE_SECTIONS } from '../../../lib/server/engine/rulebook';

test('every section has rules, ids are unique, and the same machine gives the same version', () => {
  const a = rulebook();
  for (const s of RULE_SECTIONS) assert.ok(a.rules.some((r) => r.section === s), s);
  assert.equal(new Set(a.rules.map((r) => r.id)).size, a.rules.length);
  assert.equal(rulebook().version, a.version);
  assert.ok(a.rules.every((r) => r.rule.trim().length > 10 && !/undefined|null/.test(r.rule)), 'no empty or broken rule text');
});

test("the firm's trust levels are rules: changing one changes that rule and the version", () => {
  const a = rulebook({ chase: 'propose' });
  const b = rulebook({ chase: 'auto' });
  const ca = a.rules.find((r) => r.id === 'level:chase')!;
  const cb = b.rules.find((r) => r.id === 'level:chase')!;
  assert.notEqual(ca.hash, cb.hash);
  assert.notEqual(a.version, b.version);
  assert.match(cb.rule, /sent automatically/);
});

test('delays are listed as context, not as something that holds exchange', () => {
  const r = rulebook().rules.find((x) => x.id === 'issue:buyer_delay')!;
  assert.match(r.rule, /Recorded as context: no hold/);
});
