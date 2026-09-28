/**
 * A chase puts the thing back in front of the person: the same link, the same form, or exactly
 * what is still outstanding, so nobody has to dig out our first email.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, TENANT, MATTER, USER } from './helpers';
import { CHASES, render } from '../../../lib/server/comms/templates';

const lastChase = (h: ReturnType<typeof harness>, template: string) => [...h.ports.chaser.chases].reverse().find((c) => c.template === template);

test('the ID chase sends the link to the check again', async () => {
  const h = harness();
  h.ports.idCheckProvider.link = 'https://id.example/check/abc';
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [] } as never);
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  h.advanceDays(6);
  await h.svc.tick(TENANT, MATTER);
  const c = lastChase(h, 'chase_id_documents');
  assert.ok(c, 'chased');
  assert.match(String(c!.context?.resend), /https:\/\/id\.example\/check\/abc/);
});

test('without a link, the ID chase says what is needed and how to send it', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [] } as never);
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  h.advanceDays(6);
  await h.svc.tick(TENANT, MATTER);
  const resend = String(lastChase(h, 'chase_id_documents')!.context?.resend);
  assert.match(resend, /passport/);
  assert.match(resend, /proof of address/);
});

test('the proof-of-funds chase sends the form link again', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [] } as never);
  await h.svc.requestProofOfFunds(TENANT, MATTER, USER);
  const url = (await h.svc.getState(TENANT, MATTER)).proofOfFunds.formUrl!;
  h.advanceDays(6);
  await h.svc.tick(TENANT, MATTER);
  assert.ok(String(lastChase(h, 'chase_proof_of_funds')!.context?.resend).includes(url));
});

test('unanswered enquiries go in one chase that lists them all, each recorded as chased', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false } as never);
  await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E1', subject: 'Boundary ownership' });
  await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E2', subject: 'Damp guarantee' });
  h.advanceDays(8);
  await h.svc.tick(TENANT, MATTER);
  const chases = h.ports.chaser.chases.filter((c) => c.template === 'chase_enquiry_reply');
  assert.equal(chases.length, 1, 'one letter, not one per enquiry');
  assert.match(String(chases[0].context?.resend), /1\. Boundary ownership[\s\S]*2\. Damp guarantee/);
  const s = await h.svc.getState(TENANT, MATTER);
  assert.deepEqual(s.waits.filter((w) => w.key === 'enquiry').map((w) => w.chasesSentAt.length), [1, 1]);
});

test('every chase template carries the resend block where there is something to resend', () => {
  for (const key of ['chase_id_documents', 'chase_proof_of_funds', 'chase_property_forms', 'chase_signed_documents', 'chase_enquiry_reply', 'chase_contract_pack', 'chase_management_pack', 'chase_redemption_statement']) {
    assert.ok(CHASES[key].body.includes('{{resend}}'), key);
    const r = render(CHASES[key], { matterRef: 'R1', address: '1 High St', property: '1 High St', firstName: 'Ann', resend: 'RESEND-BLOCK', feeEarner: 'Jo', firmName: 'Firm', transaction: 'purchase' });
    assert.ok(r.body.includes('RESEND-BLOCK'), key);
  }
});

test('a status update that says we are waiting on the client hands them the link too', async () => {
  const { clientOverview } = await import('../../../lib/server/engine/client-overview');
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [] } as never);
  await h.svc.requestProofOfFunds(TENANT, MATTER, USER);
  h.advanceDays(3);
  const s = await h.svc.getState(TENANT, MATTER);
  const ov = clientOverview(s, h.ports.now());
  assert.match(ov.text, /Still waiting on you/);
  assert.ok(ov.text.includes(`Proof-of-funds form: ${s.proofOfFunds.formUrl}`), ov.text);
});

test('the signature replaces the bare name lines and carries the firm, the SRA line and the notice', async () => {
  const { buildSignature, signedText, signedHtml } = await import('../../../lib/server/signature');
  const sig = buildSignature({ name: 'Smith & Co', addressLine1: '1 High St', addressLine2: null, town: 'Leeds', postcode: 'LS1 1AA', phone: '0113 000', sraNumber: '123456', website: 'smith.co.uk', logoUrl: null, signatureNotice: 'We will never change our bank details by email.' }, { name: 'Jo Bloggs', jobTitle: 'Conveyancer', phone: null, email: 'jo@smith.co.uk' });
  const text = signedText('Hello Ann,\n\nA reminder.\n\nKind regards,\nJo Bloggs\nSmith & Co', sig);
  assert.equal(text.match(/Jo Bloggs/g)?.length, 1, 'the name once');
  assert.match(text, /Kind regards,\n\nJo Bloggs, Conveyancer\nSmith & Co/);
  assert.match(text, /SRA number 123456/);
  const html = signedHtml('Hi <b>\n\nJo Bloggs', sig);
  assert.ok(html.includes('Hi &lt;b&gt;'), 'the body is escaped');
  assert.ok(html.includes('bank details by email'));
});
