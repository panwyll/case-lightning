/**
 * An effect that fails (a proposal that could not be written, an update that could not go)
 * is not only a line in the server log: it is written on the case as an issue, so a person
 * sees that the engine did not do what it should have, and why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openIssues } from '../../../lib/server/engine/types';
import { harness, TENANT, MATTER, USER } from './helpers';

test('an effect that fails is written on the case as an issue carrying the reason, once', async () => {
  const h = harness();
  h.ports.autoStartOnEnrol = true;
  await h.store.setLevel(TENANT, 'client_update', 'propose');
  h.ports.documents.createGenerated = async () => { throw new Error('document store unavailable'); };
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  const s = await h.svc.getState(TENANT, MATTER);
  const issues = openIssues(s).filter((i) => i.kind === 'other');
  assert.equal(issues.length, 1, 'one issue for the failed effect');
  assert.match(issues[0].title, /could not act on matter created/);
  assert.match(issues[0].detail ?? '', /document store unavailable/);
  assert.equal(issues[0].gate, 'none', 'it tells; it holds nothing');
  assert.equal(s.stage, 'instruction');
});
