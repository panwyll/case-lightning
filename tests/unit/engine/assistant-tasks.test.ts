/** What an assistant may do from Tasks: send what moves the file along; judgement and money stay with a conveyancer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantMay, requireDeciderFor } from '../../../lib/server/engine/http';

const as = (role: string) => ({ userId: 'u', tenantId: 't', role, email: '', displayName: null }) as never;

test('an assistant may send chases, acknowledgements, routine updates, the signing pack and the form, and retry a failed send', () => {
  for (const k of ['proposal:chase', 'proposal:acknowledgement', 'proposal:client_update', 'proposal:signing_pack', 'proposal:proof_of_funds_request', 'issue:send_failed:retry']) assert.ok(assistantMay(k), k);
});

test('advice, legal review, fees and money are a conveyancer\'s', () => {
  for (const k of ['proposal:survey_advice', 'proposal:search_order', 'proposal:enquiry_draft', 'proposal:id_check_request', 'title', 'search', 'bank_details', 'proof_of_funds', 'report_on_title', null]) {
    assert.ok(!assistantMay(k), String(k));
    assert.throws(() => requireDeciderFor(as('ASSISTANT'), k));
    assert.doesNotThrow(() => requireDeciderFor(as('CONVEYANCER'), k));
  }
});
