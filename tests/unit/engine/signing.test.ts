/**
 * Signing: what the client signs, wet ink or electronic per deed (the lender's rules and the
 * firm's provider), the pack and its wait, and the gate: a deed counts as signed only with its
 * signed copy on file, and a wet-ink one only once the original is with the firm.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, TENANT, MATTER, USER } from './helpers';
import { deedsToSign } from '../../../lib/server/engine/types';

async function purchase(opts: { parties?: number; lender?: boolean } = {}) {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: opts.lender ?? true, requiredSearches: [], parties: opts.parties ?? 1 } as never);
  return h;
}

test('what the client signs: a sole buyer with a mortgage signs the mortgage deed; joint buyers sign the TR1 as well', async () => {
  const sole = await purchase();
  assert.deepEqual(deedsToSign(await sole.svc.getState(TENANT, MATTER)), ['mortgage_deed']);
  const joint = await purchase({ parties: 2 });
  assert.deepEqual(deedsToSign(await joint.svc.getState(TENANT, MATTER)), ['transfer', 'mortgage_deed']);
  const cash = await purchase({ lender: false });
  assert.deepEqual(deedsToSign(await cash.svc.getState(TENANT, MATTER)), []);
});

test('a lender not known to take e-signed deeds is wet ink even when the firm signs electronically; a person can switch it', async () => {
  const h = await purchase({ parties: 2 });
  h.ports.signing.provider = 'infotrack';
  h.ports.signing.lenderAcceptsDigital = null;
  await h.svc.sendSigningPack(TENANT, MATTER);
  assert.deepEqual(h.ports.signing.packs[0], { wet: ['mortgage_deed'], electronic: ['transfer'] });
  let s = await h.svc.getState(TENANT, MATTER);
  assert.ok(s.signing.packSentAt);
  assert.ok(s.waits.some((w) => w.key === 'signed_documents' && w.closedAt === null), 'the case waits on the signed documents');
  assert.equal(s.signing.envelopes.transfer?.envelopeId, 'env-transfer');
  // This lender turns out to take e-signed deeds, but the client wants to sign in ink anyway: a person sets it.
  await h.svc.run(TENANT, MATTER, { type: 'set_signing_method', actor: USER, document: 'mortgage_deed', method: 'wet', reason: 'client prefers ink' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.signing.methods.mortgage_deed, 'wet');
});

test('the gate: a wet-ink deed recorded by hand needs the scan and the original held', async () => {
  const h = await purchase();
  await h.svc.sendSigningPack(TENANT, MATTER);
  const scan = h.doc(null, 'SIGNED_DEED');
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'mortgage_deed_executed', actor: USER, witnessed: true, completion: { documentId: null, checklist: { every_borrower: true, witnessed: true, original_held: true }, party: null, note: null, readDocument: null } } as never), /Upload the signed mortgage deed first|scan of the signed mortgage deed/i);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'mortgage_deed_executed', actor: USER, witnessed: true, completion: { documentId: scan, checklist: { every_borrower: true, witnessed: true }, party: null, note: null, readDocument: true } } as never), /original/i);
  await h.svc.run(TENANT, MATTER, { type: 'mortgage_deed_executed', actor: USER, witnessed: true, completion: { documentId: scan, checklist: { every_borrower: true, witnessed: true, original_held: true }, party: null, note: null, readDocument: true } } as never);
  const s = await h.svc.getState(TENANT, MATTER);
  assert.ok(s.deeds.mortgageDeedAt);
  assert.ok(!s.waits.some((w) => w.key === 'signed_documents' && w.closedAt === null), 'every deed back: the wait closes');
});

test('the client is chased for signed documents, but not while away', async () => {
  const h = await purchase();
  await h.svc.sendSigningPack(TENANT, MATTER);
  h.advanceDays(8);
  await h.svc.tick(TENANT, MATTER);
  assert.ok(h.ports.chaser.chases.some((c) => c.template === 'chase_signed_documents'));
});
