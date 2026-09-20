import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeExtractor, normaliseFlags, overallConfidence, referencesMatch, toMortgageFacts, toSearchFacts, toTitleFacts, toEnquiryReplyFacts, SearchExtractionSchema, ClassificationSchema } from '../../../lib/server/engine/extraction';
import { FakeLlm } from '../../../lib/server/engine/llm';
import { routeClassification, ingestDocument } from '../../../lib/server/engine/ingest';
import { initialState } from '../../../lib/server/engine/types';
import type { DocumentClassification, DocumentRef } from '../../../lib/server/engine/ports';
import { harness, firstDecision, TENANT, MATTER, USER, idClear } from './helpers';

const loc = { page: 4, section: '3.7', quote: 'Enforcement notice served 12/03/2024' };

test('normaliseFlags: codes normalised, severity never below the taxonomy floor, min confidence tracked', () => {
  const { flags, minConfidence } = normaliseFlags([
    { code: 'planning enforcement', severity: 'info', description: 'Notice served', locator: loc, confidence: 0.7 },
    { code: 'ROAD_ADOPTED', severity: 'info', description: 'Adopted', locator: { page: 2, section: '', quote: '' }, confidence: 0.99 },
  ]);
  assert.equal(flags[0].code, 'PLANNING_ENFORCEMENT');
  assert.equal(flags[0].severity, 'high', 'model said info; taxonomy floor is high');
  assert.equal(flags[1].severity, 'info');
  assert.equal(flags[1].locator?.section, undefined);
  assert.equal(minConfidence, 0.7);
});

test('overallConfidence: minimum of all, capped by scan quality', () => {
  assert.equal(overallConfidence(0.95, [0.9, 0.99], 'good'), 0.9);
  assert.equal(overallConfidence(0.95, [], 'poor'), 0.6);
  assert.equal(overallConfidence(0.95, [0.9], 'unreadable'), 0);
});

test('toSearchFacts: a mismatched search type is itself a flag', () => {
  const out = SearchExtractionSchema.parse({ searchType: 'LLC1', provider: 'X', searchDate: '', propertyAddressAsSearched: '1 Test St', flags: [], summaryFields: [{ label: 'Road', value: 'Adopted', locator: loc }], scanQuality: 'good', confidence: 0.95 });
  const facts = toSearchFacts(out, 'CON29');
  assert.equal(facts.searchType, 'CON29');
  assert.equal(facts.flags[0].code, 'SEARCH_TYPE_MISMATCH');
  assert.equal(facts.summaryFields?.Road, 'Adopted');
});

test('toMortgageFacts / toTitleFacts / toEnquiryReplyFacts shape the engine types', () => {
  const m = toMortgageFacts({ lender: ' Big Bank ', borrowerNames: [], propertyAddress: '', amountPennies: 0, expiryDate: '', conditions: [{ code: 'sc 4', text: 'Retention £5,000', standard: false, locator: loc, confidence: 0.9 }], scanQuality: 'fair', confidence: 0.97 });
  assert.equal(m.lender, 'Big Bank');
  assert.equal(m.conditions[0].code, 'SC_4');
  assert.equal(m.confidence, 0.9);
  assert.equal(m.amountPennies, undefined);
  const t = toTitleFacts({ titleNumber: 'ab123', tenure: 'freehold', editionDate: '', registeredProprietors: [], propertyDescription: '', restrictions: [], charges: [{ code: 'C1', text: 'Charge', register: 'C', locator: loc, confidence: 0.8 }], covenants: [], scanQuality: 'good', confidence: 0.99 });
  assert.equal(t.titleNumber, 'AB123');
  assert.equal(t.confidence, 0.8);
  const e = toEnquiryReplyFacts({ replies: [{ enquiryReference: 'Enquiry 2', status: 'partial', replyText: '…', issues: [], locator: loc, confidence: 0.9 }, { enquiryReference: '1', status: 'answered', replyText: '…', issues: [], locator: loc, confidence: 0.95 }], scanQuality: 'good', confidence: 0.95 }, 'E1');
  assert.equal(e?.status, 'answered');
  assert.equal(toEnquiryReplyFacts({ replies: [], scanQuality: 'good', confidence: 1 }, 'E1'), null);
});

test('referencesMatch tolerates the ways solicitors write enquiry numbers', () => {
  assert.ok(referencesMatch('E1', '1'));
  assert.ok(referencesMatch('Enquiry 3', 'E3'));
  assert.ok(referencesMatch('e2-f1', 'E2-F1'));
  assert.ok(!referencesMatch('E1', 'E11'));
  assert.ok(!referencesMatch('', 'E1'));
});

test('ClaudeExtractor: reads the document once, persists, and reuses the cached facts on the same bytes', async () => {
  const llm = new FakeLlm(() => ({ searchType: 'CON29', provider: 'LA', searchDate: '2026-09-01', propertyAddressAsSearched: '1 Test St', flags: [{ code: 'PLANNING_ENFORCEMENT', severity: 'high', description: 'Notice', locator: loc, confidence: 0.93 }], summaryFields: [], scanQuality: 'good', confidence: 0.96 }));
  const writes: unknown[] = [];
  const doc: DocumentRef = { id: 'd1', tenantId: TENANT, matterId: MATTER, docType: null, fileName: 'con29.pdf', webUrl: null, extractedFacts: null, extractionConfidence: null };
  const ex = new ClaudeExtractor(llm, { load: async () => ({ kind: 'pdf', data: 'QUJD' }) }, { write: async (_d, facts, confidence) => { writes.push({ facts, confidence }); } }, { model: 'fake-model' });
  const facts = await ex.extractSearch(doc, 'CON29');
  assert.equal(facts.flags[0].code, 'PLANNING_ENFORCEMENT');
  assert.equal(facts.confidence, 0.93);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].meter.feature, 'DOC_EXTRACT');
  assert.equal(writes.length, 1);
  // second read with the persisted facts on the document → no model call
  const cachedDoc: DocumentRef = { ...doc, extractedFacts: (writes[0] as { facts: unknown }).facts };
  const again = await ex.extractSearch(cachedDoc, 'CON29');
  assert.deepEqual(again, facts);
  assert.equal(llm.calls.length, 1);
});

test('ClaudeExtractor: model output that fails the schema is an error, never a guess', async () => {
  const llm = new FakeLlm(() => ({ searchType: 'CON29', flags: 'nope' }));
  const ex = new ClaudeExtractor(llm, { load: async () => ({ kind: 'pdf', data: 'QUJD' }) }, null, { model: 'fake' });
  const doc: DocumentRef = { id: 'd1', tenantId: TENANT, matterId: MATTER, docType: null, fileName: 'x.pdf', webUrl: null, extractedFacts: null, extractionConfidence: null };
  await assert.rejects(ex.extractSearch(doc, 'CON29'), /failed schema/);
});

const cls = (over: Partial<DocumentClassification>): DocumentClassification => ({ role: 'other', searchType: null, enquiryReferences: [], titleNumber: null, lender: null, confidence: 0.95, reason: 'test', ...over });

test('routeClassification: deterministic routing against the matter state', () => {
  const s = initialState(TENANT, MATTER);
  assert.equal(routeClassification(s, cls({ role: 'search', searchType: 'CON29' })).kind, 'skip');
  s.enrolled = true;
  s.hasLender = true;
  assert.deepEqual(routeClassification(s, cls({ role: 'search', searchType: 'CON29' })), { kind: 'search', searchType: 'CON29', recordOrderFirst: true });
  s.searches.CON29 = { searchType: 'CON29', cycle: 1, status: 'ordered', orderedAt: 'x', returnedAt: null, documentId: null, facts: null, flags: [], decisionEventId: null, resolution: null };
  assert.deepEqual(routeClassification(s, cls({ role: 'search', searchType: 'CON29' })), { kind: 'search', searchType: 'CON29', recordOrderFirst: false });
  s.searches.CON29.status = 'cleared';
  assert.equal(routeClassification(s, cls({ role: 'search', searchType: 'CON29' })).kind, 'skip');
  assert.equal(routeClassification(s, cls({ role: 'search', searchType: 'CON29', confidence: 0.5 })).kind, 'skip');
  // enquiries: exactly one match, or the only open one when the reply names none
  s.enquiries.E1 = { enquiryId: 'E1', subject: 'a', status: 'raised', raisedAt: 'x', repliedAt: null, documentId: null, decisionEventId: null, resolution: null };
  s.enquiries.E2 = { ...s.enquiries.E1, enquiryId: 'E2' };
  assert.deepEqual(routeClassification(s, cls({ role: 'enquiry_reply', enquiryReferences: ['2'] })), { kind: 'enquiry_reply', enquiryId: 'E2' });
  assert.equal(routeClassification(s, cls({ role: 'enquiry_reply', enquiryReferences: [] })).kind, 'skip');
  assert.equal(routeClassification(s, cls({ role: 'enquiry_reply', enquiryReferences: ['1', '2'] })).kind, 'skip');
  s.enquiries.E2.status = 'cleared';
  assert.deepEqual(routeClassification(s, cls({ role: 'enquiry_reply', enquiryReferences: [] })), { kind: 'enquiry_reply', enquiryId: 'E1' });
  assert.equal(routeClassification(s, cls({ role: 'mortgage_offer' })).kind, 'mortgage_offer');
  s.hasLender = false;
  assert.equal(routeClassification(s, cls({ role: 'mortgage_offer' })).kind, 'skip');
  assert.equal(routeClassification(s, cls({ role: 'title' })).kind, 'title');
  assert.equal(routeClassification(s, cls({ role: 'id_check' })).kind, 'skip');
  s.manualHandling = { required: true, reason: 'leasehold_unsupported' };
  assert.equal(routeClassification(s, cls({ role: 'title' })).kind, 'skip');
});

test('ingestDocument end to end: a classified search result flows into the engine and gets flagged', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const docId = h.doc({ searchType: 'CON29', flags: [{ code: 'PLANNING_ENFORCEMENT', severity: 'high', description: 'Notice', locator: { page: 4 } }], confidence: 0.93 });
  const doc = (await h.ports.documents.get(TENANT, docId))!;
  const ports = { ...h.ports, classifier: { name: 'fake', classify: async () => cls({ role: 'search', searchType: 'CON29' }) } };
  const report = await ingestDocument(h.svc, ports, TENANT, MATTER, doc);
  assert.equal(report.action.kind, 'search');
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.searches.CON29.status, 'flagged');
  assert.equal(firstDecision(s).sourceDocumentId, docId);
});

test('ClassificationSchema accepts the shape the classifier prompt asks for', () => {
  const c = ClassificationSchema.parse({ role: 'search', searchType: 'CON29', enquiryReferences: [], titleNumber: '', lender: '', scanQuality: 'good', pageCount: 12, confidence: 0.9, reason: 'CON29 header' });
  assert.equal(c.searchType, 'CON29');
});
