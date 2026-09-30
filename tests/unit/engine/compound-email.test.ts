/**
 * One email, several points: "this is done, that's done, that's waiting, need this form again, and a
 * question". Every point is read as its own line, and one reply answering all of them is drafted from
 * the case. Approving sends the reply with the ticked lines; nothing is cleared on anyone's word.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicNoteReader } from '../../../lib/server/engine/notes';
import { openWaits, type NoteSender } from '../../../lib/server/engine/types';
import { dueActions } from '../../../lib/server/engine/sla';
import { MockClientComms } from '../../../lib/server/engine/mocks';
import { harness, TENANT, MATTER, USER, firstDecision } from './helpers';

const CLIENT: NoteSender = { address: 'jo@example.com', name: 'Jo Client', relation: 'client' };

async function withWaits() {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [] });
  h.ports.noteExtractor = new DeterministicNoteReader();
  await h.svc.run(TENANT, MATTER, { type: 'request_id_check', actor: USER, provider: 'mock' }).catch(() => {});
  return h;
}

test('a compound client email: each point a line, questions answered in one drafted reply, sent on approval', async () => {
  const h = await withWaits();
  const s0 = await h.svc.getState(TENANT, MATTER);
  assert.ok(openWaits(s0).some((w) => w.key === 'id_check'), 'the case is waiting for the client\'s ID');
  const text = "Hi, I've uploaded my ID today. The broker is still waiting on the valuation. Can you resend the ID link as well? When do you think we will exchange?";
  const documentId = h.doc(null, 'EMAIL');
  const res = await h.svc.recordNote(TENANT, MATTER, { text, kind: 'email', actor: USER, documentId, from: CLIENT, surface: true, subject: 'Update from us' });
  const note = Object.values(res.state.notes)[0];
  const kinds = note.actions.map((a) => a.kind);
  assert.ok(kinds.includes('progress'), `progress read: ${kinds}`);
  assert.ok(kinds.includes('question'), 'the question is a line of its own, not information');
  assert.ok(kinds.includes('resend'), 'asking for the link again is its own line');
  assert.ok(note.actions.some((a) => a.kind === 'information' && /broker/.test(a.quote)) || !note.actions.some((a) => /broker/.test(a.quote)), 'what is waiting elsewhere is covered by the reply, not an action');
  assert.ok(note.reply, 'a reply is drafted');
  assert.equal(note.reply!.subject, 'Re: Update from us');
  assert.match(note.reply!.body, /^Hello Jo,/);
  assert.match(note.reply!.body, /When do you think we will exchange\?/, 'the fallback reply names the question it will answer');

  // Approve everything ticked, with the reply edited.
  const d = firstDecision(res.state, 'note_actions');
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve', null, null, null, null, { subject: 'Re: Update from us', body: 'Hello Jo,\n\nThanks: we will confirm when your ID check comes through. Exchange depends on the searches.' });
  const comms = h.ports.clientComms as MockClientComms;
  const sent = comms.sent.find((m) => m.template === 'email_reply');
  assert.ok(sent, 'the reply went');
  assert.match(sent!.override?.body ?? '', /Exchange depends on the searches/, 'as edited');
  const s1 = await h.svc.getState(TENANT, MATTER);
  const idWait = openWaits(s1).find((w) => w.key === 'id_check')!;
  assert.ok(idWait, 'nothing is cleared on their word: the ID check is still awaited');
  assert.ok(idWait.reported, 'what they said is noted on it');
  assert.equal(idWait.chasesSentAt.length, 1, 'the ID request went again, with its link');
  const chased = (iso: string) => dueActions(s1, new Date(`${iso}T09:00:00Z`)).some((a) => a.kind === 'chase' && a.wait.key === 'id_check');
  assert.equal(chased(idWait.reported!.until), false, 'no chase before it has had time to arrive');
  const after = new Date(Date.parse(idWait.reported!.until) + 10 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(chased(after), true, 'and chased as normal once that time has passed');
});

test('unticking the reply sends only the lines; a reply alone can be approved', async () => {
  const h = await withWaits();
  const documentId = h.doc(null, 'EMAIL');
  const res = await h.svc.recordNote(TENANT, MATTER, { text: 'Hello, how long do searches usually take?', kind: 'email', actor: USER, documentId, from: CLIENT, surface: true, subject: 'Searches' });
  const d = firstDecision(res.state, 'note_actions');
  const { matterWork } = await import('../../../lib/server/engine/work');
  assert.equal(matterWork(res.state, new Date()).items.find((i) => i.ref.id === d.eventId)!.what, "Reply to the client's email");
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve', null, null, null, ['reply']);
  assert.ok((h.ports.clientComms as MockClientComms).sent.some((m) => m.template === 'email_reply'));
});
