/** Sent email is filed with nobody looking only when it is certainly the case: cross-contamination is the risk (matching.ts sentEmailCertain). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentEmailCertain, type Candidate, type MatchSignal } from '../../../lib/server/matching';

const sig = (kind: MatchSignal['kind']): MatchSignal => ({ kind, detail: kind, weight: 0.5 });
const cand = (matterId: string, ...kinds: Array<MatchSignal['kind']>): Candidate => ({ matterId, matterRef: matterId, propertyAddress: '', score: 1, band: 'AUTO', signals: kinds.map(sig) });

test('a conversation already on the case, or its reference sent to someone on its email, is certain', () => {
  const a = cand('A', 'LINKED_THREAD');
  assert.equal(sentEmailCertain(a, [a]), true);
  const b = cand('A', 'CASE_REF_TOKEN', 'PARTICIPANT_EMAIL');
  assert.equal(sentEmailCertain(b, [b]), true);
  const c = cand('A', 'FIRM_REF', 'PARTICIPANT_EMAIL');
  assert.equal(sentEmailCertain(c, [c]), true);
});

test('anything less is left to a person', () => {
  assert.equal(sentEmailCertain(null), false);
  assert.equal(sentEmailCertain(cand('A', 'CASE_REF_TOKEN')), false, 'a reference to someone new: maybe a new matter quoting an old ref');
  assert.equal(sentEmailCertain(cand('A', 'PARTICIPANT_EMAIL', 'ADDRESS', 'STREET', 'NAME')), false, 'the agent and the address, no reference: the agent may have two of our cases on that street');
  assert.equal(sentEmailCertain(cand('A', 'FIRM_REF', 'CONTACT_FIRM')), false, 'their firm, not a person on the case');
});

test('another case named or linked in the same email is never certain', () => {
  const a = cand('A', 'CASE_REF_TOKEN', 'PARTICIPANT_EMAIL');
  assert.equal(sentEmailCertain(a, [a, cand('B', 'FIRM_REF')]), false, 'two references in one email');
  const l = cand('A', 'LINKED_THREAD');
  assert.equal(sentEmailCertain(l, [l, cand('B', 'LINKED_THREAD')]), false, 'one conversation on two cases');
  assert.equal(sentEmailCertain(a, [a, cand('B', 'PARTICIPANT_EMAIL', 'ADDRESS')]), true, 'another case sharing only a contact does not undo a reference');
});
