/** EPA, live (epa/live.ts): whose an InTouch action is, and what a task's name says it is. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personFor } from '../../../lib/server/epa/live';
import { fromInTouchItem, kindFromName } from '../../../lib/server/epa/taxonomy';

const people = [
  { id: 'u1', email: 'Dan.Shaw@firm.test', display_name: 'Dan Shaw' },
  { id: 'u2', email: 'ella@firm.test', display_name: 'Ella  Hughes' },
  { id: 'u3', email: 'other@firm.test', display_name: 'Sam Lee' },
  { id: 'u4', email: 'sam2@firm.test', display_name: 'Sam Lee' },
];

test('a fee earner is the person with their email, else the one person with their name', () => {
  assert.equal(personFor(people, { email: 'dan.shaw@FIRM.test', name: null }), 'u1');
  assert.equal(personFor(people, { email: null, name: 'ella hughes' }), 'u2');
  assert.equal(personFor(people, { email: 'nobody@firm.test', name: 'Dan Shaw' }), 'u1');
});

test('a name two people share, or no fee earner, is nobody', () => {
  assert.equal(personFor(people, { email: null, name: 'Sam Lee' }), null);
  assert.equal(personFor(people, null), null);
});

test('a task named for its work is that work; any other name goes to the model', () => {
  assert.equal(kindFromName('Send Report on Title'), 'report_on_title');
  assert.equal(kindFromName('Submit SDLT5'), 'sdlt_return');
  assert.equal(kindFromName('Raise enquiries'), 'raising_enquiries');
  assert.equal(kindFromName('Welcome call'), null);
  // A document with no telling name is still filing.
  assert.equal(fromInTouchItem({ kind: 'document', name: 'scan0042.pdf' }), 'filing');
});
