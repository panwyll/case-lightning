import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSummariser, ClaudeReportDrafter, validateSummary, renderSummary, assembleReport } from '../../../lib/server/engine/ai';
import { FakeLlm } from '../../../lib/server/engine/llm';
import { initialState, type Flag } from '../../../lib/server/engine/types';
import type { DocumentRef } from '../../../lib/server/engine/ports';
import { harness, resolve, TENANT, MATTER, USER, idClear, searchFlagged, titleClear, searchClear } from './helpers';

const flags: Flag[] = [
  { code: 'PLANNING_ENFORCEMENT', severity: 'high', description: 'Enforcement notice registered 2024 re: rear extension', locator: { page: 4, section: '3.7', quote: 'Enforcement notice served 12/03/2024' } },
  { code: 'CONSERVATION_AREA', severity: 'low', description: 'Property is in a conservation area', locator: { page: 2 } },
];
const allowed = flags.map((f) => `${f.code} ${f.description} ${f.locator?.quote ?? ''}`).join('\n');
const good = {
  headline: 'Two entries in the CON29 need a decision before exchange.',
  findings: [
    { code: 'PLANNING_ENFORCEMENT', explanation: 'The local authority records an enforcement notice served 12/03/2024 concerning the rear extension. This usually means works were done without permission; the notice may require removal or retrospective consent. Typically the seller is asked for evidence of compliance or an indemnity policy.' },
    { code: 'CONSERVATION_AREA', explanation: 'The property lies in a conservation area, which restricts external alterations and tree works. This is normally acceptable but must be explained to the client in the report on title.' },
  ],
  whatToCheckInSource: 'Page 4, question 3.7 for the notice; page 2 for the conservation area entry.',
};

test('validateSummary: accepts a faithful summary', () => {
  assert.deepEqual(validateSummary(flags, allowed, good), { ok: true, problems: [] });
});

test('validateSummary: rejects missing flags, invented flags, recommendations and invented figures', () => {
  assert.match(validateSummary(flags, allowed, { ...good, findings: [good.findings[0]] }).problems.join(), /CONSERVATION_AREA not explained/);
  assert.match(validateSummary(flags, allowed, { ...good, findings: [...good.findings, { code: 'FLOOD_RISK_HIGH', explanation: 'x'.repeat(50) }] }).problems.join(), /unknown flag FLOOD_RISK_HIGH/);
  assert.match(validateSummary(flags, allowed, { ...good, headline: 'You should approve this.' }).problems.join(), /recommendation/);
  const invented = { ...good, findings: [{ ...good.findings[0], explanation: good.findings[0].explanation + ' A fine of £12,500 was imposed on 01/02/2025.' }, good.findings[1]] };
  const p = validateSummary(flags, allowed, invented).problems;
  assert.ok(p.some((x) => /£12500/.test(x)), p.join());
  assert.ok(p.some((x) => /01\/02\/2025/.test(x)), p.join());
});

test('renderSummary keeps the deterministic flag list and options; the model only supplies the explanations', () => {
  const s = renderSummary('search', 'CON29 search', flags, good);
  assert.match(s, /1\. \[HIGH\] Enforcement notice registered 2024 re: rear extension \(see p\.4, 3\.7\)/);
  assert.match(s, /2\. \[LOW\] Property is in a conservation area \(see p\.2\)/);
  assert.match(s, /Options: approve — proceed as standard/);
  assert.match(s, /Check in the source: Page 4/);
});

test('ClaudeSummariser: validated output replaces the template; rejected output falls back to null', async () => {
  const state = initialState(TENANT, MATTER);
  const source: DocumentRef = { id: 'd1', tenantId: TENANT, matterId: MATTER, docType: 'SEARCH', fileName: 'con29.pdf', webUrl: null, extractedFacts: null, extractionConfidence: null };
  const loader = { load: async () => ({ kind: 'pdf' as const, data: 'QUJD' }) };
  const ok = new ClaudeSummariser(new FakeLlm(() => good), loader, { model: 'fake' });
  const r = await ok.summarise({ kind: 'search', subjectLabel: 'CON29 search', flags, source, state });
  assert.equal(r?.by, 'fake');
  assert.match(r!.text, /rear extension/);
  const bad = new ClaudeSummariser(new FakeLlm(() => ({ ...good, headline: 'We recommend you approve this.' })), loader, { model: 'fake' });
  assert.equal(await bad.summarise({ kind: 'search', subjectLabel: 'CON29 search', flags, source, state }), null);
  const failing = new ClaudeSummariser(new FakeLlm(() => { throw new Error('boom'); }), loader, { model: 'fake' });
  assert.equal(await failing.summarise({ kind: 'search', subjectLabel: 'CON29 search', flags, source, state }), null);
});

test('assembleReport: sections without a real citation are dropped and reported; citations dedupe', () => {
  const known = new Map<string, DocumentRef>([
    ['t1', { id: 't1', tenantId: TENANT, matterId: MATTER, docType: 'TITLE', fileName: 'title.pdf', webUrl: null, extractedFacts: null, extractionConfidence: null }],
    ['s1', { id: 's1', tenantId: TENANT, matterId: MATTER, docType: 'SEARCH', fileName: 'con29.pdf', webUrl: null, extractedFacts: null, extractionConfidence: null }],
  ]);
  const r = assembleReport(
    {
      sections: [
        { heading: 'Introduction', body: 'Hello', sourceDocumentIds: [] },
        { heading: 'Title', body: 'Freehold AB1', sourceDocumentIds: ['t1'] },
        { heading: 'Searches', body: 'CON29 clear', sourceDocumentIds: ['s1', 't1'] },
        { heading: 'Made up', body: 'Citing nothing real', sourceDocumentIds: ['zzz'] },
      ],
      outstanding: ['Confirm the deposit source'],
    },
    known
  );
  assert.deepEqual(r.dropped, ['Made up']);
  assert.deepEqual(r.citations.map((c) => c.documentId), ['t1', 's1']);
  assert.match(r.content, /POINTS FOR THE CONVEYANCER TO CONFIRM/);
  assert.doesNotMatch(r.content, /Citing nothing real/);
});

test('ClaudeReportDrafter through the engine: the draft is a decision citing real documents; a draft with no citations falls back to the template', async () => {
  const h = harness();
  const { svc } = h;
  await svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'] });
  await svc.requestIdCheck(TENANT, MATTER, USER);
  await svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const con29 = h.doc(searchClear('CON29'));
  await svc.searchReturned(TENANT, MATTER, 'CON29', con29);
  const title = h.doc(titleClear());
  await svc.titleReceived(TENANT, MATTER, title);
  assert.equal((await svc.getState(TENANT, MATTER)).stage, 'contract_review');

  const llm = new FakeLlm(() => ({ sections: [{ heading: 'Intro', body: 'Dear client', sourceDocumentIds: [] }, { heading: 'Title', body: 'Freehold, no restrictions', sourceDocumentIds: [title] }, { heading: 'Searches', body: 'CON29: road adopted', sourceDocumentIds: [con29] }], outstanding: [] }));
  h.ports.reportDrafter = new ClaudeReportDrafter(llm, { model: 'fake' });
  const r = await svc.draftReportOnTitle(TENANT, MATTER);
  const d = Object.values(r.state.decisions).find((x) => x.kind === 'report_on_title')!;
  assert.equal(d.summarisedBy, 'fake');
  assert.deepEqual(d.citations.map((c) => c.documentId).sort(), [con29, title].sort());
  const draftDoc = await h.ports.documents.get(TENANT, d.sourceDocumentId);
  assert.match((draftDoc!.extractedFacts as { content: string }).content, /CON29: road adopted/);
  // reject, then a drafter that cites nothing → template fallback
  await resolve(h, d.eventId, 'reject', USER, 'Redo');
  h.ports.reportDrafter = new ClaudeReportDrafter(new FakeLlm(() => ({ sections: [{ heading: 'Intro', body: 'x', sourceDocumentIds: [] }], outstanding: [] })), { model: 'fake' });
  const r2 = await svc.draftReportOnTitle(TENANT, MATTER);
  const d2 = Object.values(r2.state.decisions).find((x) => x.kind === 'report_on_title' && x.status === 'pending')!;
  assert.match(d2.summarisedBy, /template-report-drafter/);
  // the searchFlagged fixture is still importable (keeps helpers honest)
  void searchFlagged;
});
