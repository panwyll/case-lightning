import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSearch, evaluateEnquiryReply, evaluateMortgageOffer, evaluateTitle, evaluateIdCheck, buildDecision, templateSummary } from '../../../lib/server/engine/rules';
import { searchClear, searchFlagged, searchLowConfidence, replyClear, replyPartial, offerClear, offerSpecial, titleClear, titleWithCharge, titleLeasehold, idClear, idRefer } from './helpers';

test('search: info-only flags auto-clear; actionable flags route to a human', () => {
  assert.equal(evaluateSearch(searchClear('CON29')).outcome, 'clear');
  const v = evaluateSearch(searchFlagged('CON29'));
  assert.equal(v.outcome, 'flag');
  if (v.outcome === 'flag') assert.deepEqual(v.reasons, ['PLANNING_ENFORCEMENT']);
});

test('search: low extraction confidence is always a flag, even with no findings', () => {
  const v = evaluateSearch(searchLowConfidence('LLC1'));
  assert.equal(v.outcome, 'flag');
  if (v.outcome === 'flag') assert.equal(v.flags[0].code, 'LOW_EXTRACTION_CONFIDENCE');
});

test('enquiry reply: answered + no issues clears; partial / unextracted flags', () => {
  assert.equal(evaluateEnquiryReply(replyClear('E1')).outcome, 'clear');
  assert.equal(evaluateEnquiryReply(replyPartial('E1')).outcome, 'flag');
  assert.equal(evaluateEnquiryReply(null).outcome, 'flag');
});

test('mortgage: standard conditions clear; special conditions and near expiry flag', () => {
  assert.equal(evaluateMortgageOffer(offerClear(), '2026-12-01').outcome, 'clear');
  const special = evaluateMortgageOffer(offerSpecial(), '2026-12-01');
  assert.equal(special.outcome, 'flag');
  if (special.outcome === 'flag') assert.ok(special.flags.some((f) => f.code === 'NON_STANDARD_CONDITION:SC4'));
  const near = evaluateMortgageOffer({ ...offerClear(), expiryDate: '2026-12-10' }, '2026-12-01');
  assert.equal(near.outcome, 'flag');
  if (near.outcome === 'flag') assert.equal(near.flags[0].code, 'OFFER_EXPIRY_NEAR');
  const expired = evaluateMortgageOffer({ ...offerClear(), expiryDate: '2026-11-01' }, '2026-12-01');
  if (expired.outcome === 'flag') assert.equal(expired.flags[0].code, 'OFFER_EXPIRED');
});

test('title: clean freehold clears; charges flag; leasehold is out of scope', () => {
  assert.equal(evaluateTitle(titleClear()).outcome, 'clear');
  const charge = evaluateTitle(titleWithCharge());
  assert.equal(charge.outcome, 'flag');
  if (charge.outcome === 'flag') assert.equal(charge.flags[0].code, 'CHARGE:C1');
  const lease = evaluateTitle(titleLeasehold());
  if (lease.outcome === 'flag') assert.equal(lease.flags[0].code, 'LEASEHOLD_UNSUPPORTED');
});

test('id check: clear vs refer', () => {
  assert.equal(evaluateIdCheck(idClear()).outcome, 'clear');
  assert.equal(evaluateIdCheck(idRefer()).outcome, 'flag');
});

test('decision spec always cites its source and explains each flag', () => {
  const v = evaluateSearch(searchFlagged('CON29'));
  assert.equal(v.outcome, 'flag');
  if (v.outcome !== 'flag') return;
  const d = buildDecision({ kind: 'search', subjectLabel: 'CON29 search', flags: v.flags, sourceDocumentId: 'doc-1' });
  assert.equal(d.sourceDocumentId, 'doc-1');
  assert.equal(d.citations.length, 1);
  assert.equal(d.citations[0].documentId, 'doc-1');
  assert.match(d.citations[0].label, /p\.4, 3\.7/);
  assert.match(d.summary, /Enforcement notice/);
  assert.match(d.summary, /What this usually means/);
  assert.match(d.summary, /escalate to senior/);
  assert.equal(d.summarisedBy, 'template');
  // an AI summary replaces the prose but nothing else
  const ai = buildDecision({ kind: 'search', subjectLabel: 'CON29 search', flags: v.flags, sourceDocumentId: 'doc-1', summary: { text: 'Model prose', by: 'claude-x' } });
  assert.equal(ai.summary, 'Model prose');
  assert.deepEqual(ai.citations, d.citations);
  assert.deepEqual(ai.options, d.options);
});

test('template summary lists every flag with its locator', () => {
  const s = templateSummary('title', 'Title AB1', [{ code: 'CHARGE:C1', severity: 'medium', description: 'Charge to Big Bank', locator: { page: 2, section: 'C' } }]);
  assert.match(s, /1\. \[MEDIUM\] Charge to Big Bank \(see p\.2, C\)/);
});
