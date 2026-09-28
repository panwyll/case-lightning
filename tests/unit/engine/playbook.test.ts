/**
 * The playbook covers every signal the system acts on, and each rule is complete. A new note
 * command or document role fails to compile without a rule (the maps in playbook.ts); a new
 * timer-raised issue or reader rule fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PLAYBOOK, NOTE_COMMAND_RULES, DOCUMENT_ROLE_RULES, ruleHash } from '../../../lib/server/engine/playbook';
import { proposalsMarkdown } from '../../../lib/server/playbook-review';

const ids = new Set(PLAYBOOK.map((r) => r.id));

test('ids are unique and every rule says what it detects, what it does and who decides', () => {
  assert.equal(ids.size, PLAYBOOK.length);
  for (const r of PLAYBOOK) {
    assert.ok(r.signal && r.detects && r.decides && r.actions.length && r.code.length, r.id);
    assert.ok(!/undefined|NaN/.test(JSON.stringify(r)), r.id);
  }
});

test('every note command and document role points at a rule that exists', () => {
  for (const list of Object.values(NOTE_COMMAND_RULES)) for (const id of list) assert.ok(ids.has(id), id);
  for (const id of Object.values(DOCUMENT_ROLE_RULES)) assert.ok(ids.has(id), id);
});

test('every issue the timer raises has a rule', () => {
  const sla = fs.readFileSync('lib/server/engine/sla.ts', 'utf8');
  const kinds = new Set([...sla.matchAll(/issueKind: '([a-z_]+)'/g)].map((m) => m[1]));
  const RULE: Record<string, string> = { cdd_refresh: 'timer.cdd_refresh', mortgage_offer_expired: 'timer.offer_expired', mortgage_offer_expiring: 'timer.offer_expiring', search_delayed: 'timer.search_delayed', enquiry_unanswered: 'timer.enquiry_unanswered' };
  for (const k of kinds) assert.ok(RULE[k] && ids.has(RULE[k]), `timer raises ${k} but no rule covers it`);
});

test('every issue the email reader raises on its own has a rule', () => {
  const notes = fs.readFileSync('lib/server/engine/notes.ts', 'utf8');
  const raised = new Set([...notes.matchAll(/type: 'raise_issue', kind: '([a-z_]+)'/g)].map((m) => m[1]));
  const COVERED: Record<string, string> = { survey_report_outstanding: 'email.survey_done', transaction_at_risk: 'email.transaction_at_risk', mortgage_at_risk: 'email.mortgage_at_risk', source_of_funds: 'email.gift', cdd_refresh: 'email.name_change', buyer_delay: 'email.availability', boundary_discrepancy: 'email.problem' };
  for (const k of raised) assert.ok(COVERED[k] && ids.has(COVERED[k]), `the reader raises ${k} but no rule covers it`);
});

test('a rule whose words change gets a new hash (so an approval lapses)', () => {
  const r = PLAYBOOK[0];
  assert.notEqual(ruleHash(r), ruleHash({ ...r, actions: [...r.actions, 'something new'] }));
});

test('the export sets out each proposed change against current behaviour, with the code', () => {
  const r = PLAYBOOK.find((x) => x.id === 'timer.offer_expired')!;
  const md = proposalsMarkdown('Smith & Co', [{ ...r, hash: 'h', status: 'change_proposed', proposal: 'Tell the client and the agent the same day.', reviewedBy: 'Jo', reviewedAt: '2026-09-28T10:00:00Z' }]);
  assert.match(md, /# Proposed playbook changes — Smith & Co/);
  assert.match(md, /## Mortgage offer expired `timer.offer_expired`/);
  assert.match(md, /> Tell the client and the agent the same day\./);
  assert.match(md, /\*\*Code:\*\* `sla.ts timedIssueActions`/);
});
