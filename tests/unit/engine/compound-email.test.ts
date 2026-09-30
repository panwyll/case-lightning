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
  const reply = note.messages?.find((m) => m.id === 'reply');
  assert.ok(reply, 'a reply is drafted');
  assert.equal(reply!.to, 'client');
  assert.equal(reply!.subject, 'Re: Update from us');
  assert.match(reply!.body, /^Hello Jo,/);
  assert.match(reply!.body, /When do you think we will exchange\?/, 'the fallback reply names the question it will answer');

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

// ───────────────────────────── one task, several people written to ─────────────────────────────

test('"the seller is threatening to pull out": the client is replied to and the other side asked, in one task', async () => {
  const h = await withWaits();
  const documentId = h.doc(null, 'EMAIL');
  const res = await h.svc.recordNote(TENANT, MATTER, { text: 'Hi, the seller is threatening to pull out unless we can complete by Friday. Is that possible?', kind: 'email', actor: USER, documentId, from: CLIENT, surface: true, subject: 'Seller pulling out' });
  const note = Object.values(res.state.notes)[0];
  const to = (note.messages ?? []).map((m) => `${m.to}:${m.on}`);
  assert.deepEqual(to, ['client:true', 'seller_solicitor:true', 'estate_agent:false'], 'the reply and the other side ticked; the agent offered');
  assert.match(note.messages![1].body, /^Dear Colleagues,/);
  const d = firstDecision(res.state, 'note_actions');
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve', null, null, null, null, { messages: [{ id: 'msg:seller_solicitor', body: 'Dear Colleagues,\n\nPlease confirm your client\'s position today.' }] });
  const chaser = h.ports.chaser as unknown as { messages: Array<{ recipientRole: string; body: string }> };
  assert.equal(chaser.messages.length, 1, 'the other side was written to');
  assert.equal(chaser.messages[0].recipientRole, 'seller_solicitor');
  assert.match(chaser.messages[0].body, /confirm your client's position today/, 'as edited');
  assert.ok((h.ports.clientComms as MockClientComms).sent.some((m) => m.template === 'email_reply'), 'and the client was replied to');
  const s = await h.svc.getState(TENANT, MATTER);
  assert.ok(Object.values(s.issues).some((i) => i.kind === 'transaction_at_risk'), 'the issue is raised');
  assert.ok(!Object.values(s.proposals).some((p) => p.action === 'enquiry_draft'), "the issue's own automatic enquiry does not also go: the task's message is the follow-up");
});

test('a withdrawn offer: the issue, marking the offer withdrawn, the reply, and the lender offered, as separate ticks', async () => {
  const h = await withWaits();
  const documentId = h.doc(null, 'EMAIL');
  const res = await h.svc.recordNote(TENANT, MATTER, { text: 'Hi, my mortgage provider has rescinded their offer. Please advise next steps.', kind: 'email', actor: USER, documentId, from: CLIENT, surface: true, subject: 'Mortgage' });
  const note = Object.values(res.state.notes)[0];
  const cmds = note.actions.map((a) => a.command?.type).filter(Boolean);
  assert.ok(cmds.includes('raise_issue') && cmds.includes('record_mortgage_withdrawn'), `both case changes proposed: ${cmds}`);
  assert.deepEqual((note.messages ?? []).map((m) => `${m.to}:${m.on}`), ['client:true', 'lender:false']);
});

test('an agent passing on that the lender pulled out cannot mark the mortgage withdrawn; asking us something gets them a reply', async () => {
  const h = await withWaits();
  const documentId = h.doc(null, 'EMAIL');
  const res = await h.svc.recordNote(TENANT, MATTER, { text: 'Heads up, the buyer says their lender has withdrawn the offer.', kind: 'email', actor: USER, documentId, from: { address: 'sam@agents.example', name: 'Sam Agent', relation: 'agent' }, surface: true, subject: 'FYI' });
  const note = Object.values(res.state.notes)[0];
  assert.ok(!note.actions.some((a) => a.command?.type === 'record_mortgage_withdrawn'), 'hearsay does not change the case');
  assert.equal(note.messages?.length ?? 0, 0, 'news with no question: no reply drafted');
  const asks = await h.svc.recordNote(TENANT, MATTER, { text: 'Can you confirm when we are likely to exchange?', kind: 'email', actor: USER, documentId: h.doc(null, 'EMAIL'), from: { address: 'sam@agents.example', name: 'Sam Agent', relation: 'agent' }, surface: true, subject: 'Exchange' });
  assert.equal(Object.values(asks.state.notes).at(-1)!.messages?.[0]?.to, 'estate_agent', 'a question gets the agent a reply');
});

test('a client asking for a document gets it attached to the reply: one email, nothing sent separately', async () => {
  const h = await withWaits();
  h.ports.files = {
    find: async (_t, _m, what) => (/search/i.test(what) ? [{ id: 'doc-searches', fileName: 'Local search.pdf' }] : []),
    bytes: async (_t, id) => (id === 'doc-searches' ? { name: 'Local search.pdf', bytes: Buffer.from('%PDF'), contentType: 'application/pdf' } : null),
  };
  const documentId = h.doc(null, 'EMAIL');
  const res = await h.svc.recordNote(TENANT, MATTER, { text: "Hi, can you send over the searches? Can't find in my inbox", kind: 'email', actor: USER, documentId, from: CLIENT, surface: true, subject: 'Searches' });
  const note = Object.values(res.state.notes)[0];
  const line = note.actions.find((a) => a.command?.type === 'send_file_copy');
  assert.ok(line, 'read as a request for a document, not a question');
  const reply = note.messages!.find((m) => m.id === 'reply')!;
  assert.deepEqual(reply.attach?.map((a) => a.fileName), ['Local search.pdf'], 'the file is on the reply');
  assert.match(reply.body, /I attach Local search\.pdf/);
  assert.doesNotMatch(reply.body, /separately/);
  const d = firstDecision(res.state, 'note_actions');
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve');
  const comms = h.ports.clientComms as MockClientComms;
  const sent = comms.sent.filter((m) => m.template === 'email_reply' || m.template === 'file_copy');
  assert.equal(sent.length, 1, 'one email');
  assert.equal(sent[0].template, 'email_reply');
  assert.deepEqual(sent[0].attachments, ['Local search.pdf'], 'with the file attached');
});

test('an issue the client has been emailed about is marked as told, so a later reply does not raise it again', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [] });
  await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'transaction_at_risk', title: 'The seller is threatening to withdraw' });
  const id = Object.values((await h.svc.getState(TENANT, MATTER)).issues)[0].id;
  const { caseBrief, renderForDrafting } = await import('../../../lib/server/engine/brief');
  const before = renderForDrafting(caseBrief(await h.svc.getState(TENANT, MATTER), new Date()));
  assert.doesNotMatch(before, /ALREADY TOLD THE CLIENT/);
  await h.svc.sendIssueMessage(TENANT, MATTER, id, { actor: USER, to: 'client', subject: 'Your purchase', body: 'Hello Jo,\n\nThe seller has said they may withdraw.' });
  const s = await h.svc.getState(TENANT, MATTER);
  assert.ok(s.issues[id].clientToldAt);
  assert.match(renderForDrafting(caseBrief(s, new Date())), /withdraw \(holds exchange, critical\)\. ALREADY TOLD THE CLIENT/);
});

test('"can\'t find my report on title" attaches the report they were sent, never the official copies', async () => {
  const { titleClear, idClear, resolve } = await import('./helpers');
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  h.ports.noteExtractor = new DeterministicNoteReader();
  // The file finder would offer the title documents for anything with "title" in it: the report must not come from there.
  h.ports.files = { find: async () => [{ id: 'oc-1', fileName: 'Official Copy (Register) - TGL1.pdf' }], bytes: async () => ({ name: 'x', bytes: Buffer.from('x'), contentType: 'text/plain' }) };
  const ask = async () => {
    const documentId = h.doc(null, 'EMAIL');
    const res = await h.svc.recordNote(TENANT, MATTER, { text: "can't find my report on title do you mind sending it over?", kind: 'email', actor: USER, documentId, from: CLIENT, surface: true, subject: 'Report' });
    return Object.values(res.state.notes).at(-1)!.messages!.find((m) => m.id === 'reply')!;
  };
  const early = await ask();
  assert.equal(early.attach, undefined, 'not sent yet: nothing attached');
  assert.doesNotMatch(early.body, /attach|separately/i);

  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  await h.svc.draftReportOnTitle(TENANT, MATTER);
  const rot = firstDecision(await h.svc.getState(TENANT, MATTER), 'report_on_title');
  await resolve(h, rot.eventId, 'approve');
  await h.svc.sendReportOnTitle(TENANT, MATTER, USER);
  const s = await h.svc.getState(TENANT, MATTER);
  assert.ok(s.reportOnTitle.sentAt || s.reportOnTitle.interimSentAt, 'the report went');
  const later = await ask();
  assert.deepEqual(later.attach?.map((a) => [a.id, a.fileName]), [[s.reportOnTitle.draftDocumentId, 'Report on title.docx']]);
  assert.match(later.body, /I attach Report on title\.docx/);
});

test('a document request the AI reader missed is still read, and the file still goes attached', async () => {
  const h = await withWaits();
  h.ports.noteExtractor = { name: 'ai-that-missed-it', extract: async () => [] };
  h.ports.files = { find: async (_t, _m, what) => (/search/i.test(what) ? [{ id: 'doc-searches', fileName: 'Local search.pdf' }] : []), bytes: async () => null };
  const documentId = h.doc(null, 'EMAIL');
  const res = await h.svc.recordNote(TENANT, MATTER, { text: "Hi, I can't find the searches in my inbox, can you send them over?", kind: 'email', actor: USER, documentId, from: CLIENT, surface: true, subject: 'Searches' });
  const note = Object.values(res.state.notes).at(-1)!;
  assert.ok(note.actions.some((a) => a.command?.type === 'send_file_copy'), 'read by rule');
  assert.deepEqual(note.messages!.find((m) => m.id === 'reply')!.attach?.map((a) => a.fileName), ['Local search.pdf']);
});

test('a drafted reply that promises a resend without the file attached is replaced by the reply from the facts', async () => {
  const h = await withWaits();
  h.ports.files = { find: async () => [], bytes: async () => null };
  h.ports.replyDrafter = { name: 'hedger', draft: async () => ({ body: 'Hello Jo,\n\nWe will resend it to you today.' }) };
  const documentId = h.doc(null, 'EMAIL');
  const res = await h.svc.recordNote(TENANT, MATTER, { text: 'Could I have a copy of the TA10?', kind: 'email', actor: USER, documentId, from: CLIENT, surface: true, subject: 'TA10' });
  const reply = Object.values(res.state.notes).at(-1)!.messages!.find((m) => m.id === 'reply')!;
  assert.doesNotMatch(reply.body, /resend/i);
  assert.match(reply.body, /as soon as we can/);
});
