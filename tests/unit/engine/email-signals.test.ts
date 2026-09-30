/**
 * An email on a case is read like a file note: what it appears to say becomes a proposal
 * for a person, gated by who sent it. The boundary under test:
 *   • only the client can make a client decision — an agent's account of the client is information;
 *   • anyone may report a problem (a party pulling out, a job lost, a survey done);
 *   • nobody's say-so can clear ID, AML, source of funds or a search. There is no command for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicNoteReader, validateNoteActions, commandProblem } from '../../../lib/server/engine/notes';
import { blockingDecisions, type NoteSender } from '../../../lib/server/engine/types';
import { harness, TENANT, MATTER, USER, firstDecision } from './helpers';

const CLIENT: NoteSender = { address: 'jo@example.com', name: 'Jo Client', relation: 'client' };
const AGENT: NoteSender = { address: 'sam@agents.example', name: 'Sam Agent', relation: 'agent' };
const STRANGER: NoteSender = { address: 'who@nowhere.example', name: null, relation: 'unknown' };

async function enrolled() {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [] });
  h.ports.noteExtractor = new DeterministicNoteReader();
  return h;
}

async function email(h: Awaited<ReturnType<typeof enrolled>>, text: string, from: NoteSender) {
  const documentId = h.doc(null, 'EMAIL');
  return h.svc.recordNote(TENANT, MATTER, { text, kind: 'email', actor: USER, documentId, from });
}

async function approve(h: Awaited<ReturnType<typeof enrolled>>) {
  const d = firstDecision((await h.svc.getState(TENANT, MATTER)), 'note_actions');
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve');
  return { state: await h.svc.getState(TENANT, MATTER) };
}

test('"surveys are all complete" from the client asks for the report, and records nothing about the property', async () => {
  const h = await enrolled();
  const res = await email(h, 'Hi, surveys are all complete', CLIENT);
  const note = Object.values(res.state.notes)[0];
  assert.equal(note.kind, 'email');
  assert.equal(note.from?.relation, 'client');
  assert.equal(note.actions.filter((a) => a.command).length, 1);
  assert.equal(note.actions[0].command?.type, 'raise_issue');
  assert.equal((note.actions[0].command as { kind: string }).kind, 'survey_report_outstanding');
  assert.equal(blockingDecisions(res.state).filter((d) => d.kind === 'note_actions').length, 1, 'a person confirms it');
  assert.equal(res.state.survey.status, 'not_started', 'the survey workstream moves on the report, not the sentence');
  const after = await approve(h);
  const issue = Object.values(after.state.issues).find((i) => i.kind === 'survey_report_outstanding');
  assert.ok(issue, 'the issue is raised once approved');
  assert.equal(after.state.survey.status, 'not_started');
  // And the issue does what its label promises: the client is asked for the report.
  assert.ok(h.ports.clientComms.sent.some((m) => m.template === 'request_survey_report'), 'the client was asked for the report');
});

test('nobody can clear ID, AML, source of funds or a search by saying so', async () => {
  const h = await enrolled();
  const before = await h.svc.getState(TENANT, MATTER);
  const text = 'Just to confirm the ID checks and AML are all done, source of funds is verified and the searches came back clear, so you can exchange.';
  for (const from of [CLIENT, AGENT, STRANGER]) {
    const res = await email(h, text, from);
    const note = Object.values(res.state.notes).at(-1)!;
    // A stranger's email always carries one thing: who are they? Never a clearance.
    const commands = note.actions.filter((a) => a.command).map((a) => a.command!);
    assert.deepEqual(commands.map((c) => (c.type === 'raise_issue' ? c.kind : c.type)), from.relation === 'unknown' ? ['unknown_correspondent'] : [], `${from.relation}: nothing to apply`);
    assert.deepEqual(res.state.idCheck, before.idCheck);
    assert.deepEqual(res.state.proofOfFunds, before.proofOfFunds);
    assert.deepEqual(res.state.searches, before.searches);
    assert.equal(res.state.exchange.exchangedAt, null);
  }
  // And there is no command a reader could name to do it: the machine has no door.
  assert.equal(commandProblem({ type: 'record_id_check_result', outcome: 'clear' } as never), 'unknown command');
  assert.equal(commandProblem({ type: 'approve_proof_of_funds' } as never), 'unknown command');
  const forged = validateNoteActions(text, [{ kind: 'client_decision', summary: 'ID done', quote: 'ID checks and AML are all done', command: { type: 'client_decision_recorded', subject: 'id_check', decision: 'clear', note: '' } as never }], { kind: 'email', from: CLIENT });
  assert.equal(forged.actions.length, 0);
  assert.match(forged.rejected[0].reason, /not a client decision/);
});

test('"the vendor has pulled out" from the agent is a critical issue for a person, never an abandonment', async () => {
  const h = await enrolled();
  const res = await email(h, 'Bad news I am afraid, the vendor has pulled out of the sale this morning.', AGENT);
  const note = Object.values(res.state.notes)[0];
  const cmd = note.actions.find((a) => a.command)?.command as { type: string; kind: string; gate: string } | undefined;
  assert.equal(cmd?.type, 'raise_issue');
  assert.equal(cmd?.kind, 'transaction_at_risk');
  assert.equal(cmd?.gate, 'exchange');
  assert.equal(res.state.closedAt, null);
  const after = await approve(h);
  const issue = Object.values(after.state.issues).find((i) => i.kind === 'transaction_at_risk')!;
  assert.equal(issue.severity, 'critical');
  assert.equal(after.state.closedAt, null, 'abandoning the file stays a deliberate step');
  // The seller's solicitor is asked whether their client is proceeding (proposed: enquiry drafts are not automatic in the fixture).
  const ask = Object.values(after.state.proposals).find((p) => p.action === 'enquiry_draft' && String((p.detail as { subject?: string }).subject ?? '').includes('intends to proceed'));
  assert.ok(ask, 'an enquiry to the other side is proposed');
});

test('"I have lost my job" is a mortgage-at-risk issue', async () => {
  const h = await enrolled();
  const res = await email(h, "Hi, I have lost my job this week so the mortgage may be a problem. Not sure what happens now.", CLIENT);
  const kinds = Object.values(res.state.notes)[0].actions.map((a) => (a.command as { kind?: string } | null)?.kind).filter(Boolean);
  assert.ok(kinds.includes('mortgage_at_risk'), kinds.join(','));
  await approve(h);
  const sent = h.ports.clientComms.sent.find((m) => m.template === 'mortgage_change_query');
  assert.ok(sent, 'the client is asked what changed');
  assert.match(String(sent!.context.quote), /lost my job/);
});

test('a survey that is merely booked, or not done yet, is not "done"', async () => {
  const r = new DeterministicNoteReader();
  const count = async (t: string) => (await r.extract({ tenantId: TENANT, matterId: MATTER, text: t, kind: 'email' })).filter((x) => (x.command as { kind?: string } | null)?.kind === 'survey_report_outstanding').length;
  assert.equal(await count('The survey is booked for Tuesday.'), 0);
  assert.equal(await count('The survey has not been done yet.'), 0);
});

// ───────────────────────────── hearsay is confirmed with the client, not dropped ─────────────────────────────

test('the agent reporting the client\'s view asks the client to confirm; the client\'s own reply is what gets recorded', async () => {
  const h = await enrolled();
  await h.svc.surveyReceived(TENANT, MATTER, h.doc({ surveyType: 'level3', surveyor: 'J Bloggs MRICS', summary: 'Damp to the rear addition.', recommendations: [{ code: 'DAMP', text: 'Damp-proofing quote.', furtherInvestigation: false, severity: 'medium' }], confidence: 0.9 }, 'SURVEY'));
  const res = await email(h, 'Spoke to the buyer this morning. She is happy with the survey report and wants to press on to exchange.', AGENT);
  const note = Object.values(res.state.notes).find((n) => n.from?.relation === 'agent')!;
  const confirm = note.actions.find((a) => a.command?.type === 'confirm_with_client');
  assert.ok(confirm, 'hearsay becomes a request to confirm, not information');
  assert.match(confirm!.summary, /estate agent says/);
  assert.equal(blockingDecisions(res.state).filter((d) => d.kind === 'note_actions').length, 1, 'a person decides whether to ask');
  assert.equal(res.state.clientDecisions.physical_condition, undefined);

  // Approving sends the client a message (client_update is auto in the fixture levels).
  const after = await approve(h);
  assert.equal(after.state.clientDecisions.physical_condition, undefined, 'still nothing recorded');
  const sent = h.ports.clientComms.sent.find((m) => m.template === 'confirm_with_client');
  assert.ok(sent, 'the client was asked');
  assert.equal(sent!.context.claim, 'you are happy with the survey and want to proceed');
  assert.equal(sent!.context.saidBy, 'Sam Agent');

  // The client replies in their own words: now it is a decision, still for a person to approve.
  const reply = await email(h, 'Yes that is right, I am happy with the survey and want to proceed.', CLIENT);
  const clientNote = Object.values(reply.state.notes).find((n) => n.from?.relation === 'client')!;
  assert.equal(clientNote.actions.filter((a) => a.command?.type === 'client_decision_recorded').length, 1);
  const done = await approve(h);
  assert.equal(done.state.clientDecisions.physical_condition?.decision, 'satisfied');
});

test('an email from someone not on the file always reaches a person, even when it says nothing actionable', async () => {
  const h = await enrolled();
  const res = await email(h, 'Hi, I am Jo\'s wife. Just checking how things are going with the house, we are very excited!', STRANGER);
  const note = Object.values(res.state.notes)[0];
  const unknown = note.actions.find((a) => (a.command as { kind?: string } | null)?.kind === 'unknown_correspondent');
  assert.ok(unknown, 'the unknown sender is itself the thing to confirm');
  assert.match(unknown!.summary, /not on the file/);
  assert.equal(blockingDecisions(res.state).filter((d) => d.kind === 'note_actions').length, 1, 'not buried');
  const after = await approve(h);
  const issue = Object.values(after.state.issues).find((i) => i.kind === 'unknown_correspondent')!;
  assert.ok(issue);
  assert.equal(issue.gate, 'none');
});

test('a stranger reporting the client\'s decision is asked about, and the client is asked to confirm', async () => {
  const h = await enrolled();
  await h.svc.surveyReceived(TENANT, MATTER, h.doc({ surveyType: 'level3', surveyor: 'J Bloggs MRICS', summary: 'Fine.', recommendations: [], confidence: 0.9 }, 'SURVEY'));
  const res = await email(h, 'Hi, I am Jo\'s wife. We are happy with the survey report and want to proceed.', STRANGER);
  const kinds = Object.values(res.state.notes)[0].actions.map((a) => a.command?.type ?? 'none');
  assert.ok(kinds.includes('raise_issue'), 'who are they?');
  assert.ok(kinds.includes('confirm_with_client'), 'ask the client');
  assert.ok(!kinds.includes('client_decision_recorded'), 'never recorded on a stranger\'s word');
});

// ───────────────────────────── dates ─────────────────────────────

test('dates in an email are read: "14 November" gets the right year, exchange and completion are told apart', async () => {
  const { targetDatesIn, datesIn } = await import('../../../lib/server/engine/notes');
  const now = new Date('2026-09-27T09:00:00Z');
  assert.deepEqual(datesIn('on 14 November', now).map((d) => d.iso), ['2026-11-14']);
  assert.deepEqual(datesIn('on the 14th of Nov 2027', now).map((d) => d.iso), ['2027-11-14']);
  assert.deepEqual(datesIn('by 3 January', now).map((d) => d.iso), ['2027-01-03'], 'a date already well past is next year');
  assert.deepEqual(datesIn('on 14/11/26', now).map((d) => d.iso), ['2026-11-14']);
  assert.deepEqual(datesIn('Nov 14', now).map((d) => d.iso), ['2026-11-14']);
  assert.deepEqual(targetDatesIn('We would like to exchange on 7 November and complete on 14 November.', now), { targetExchangeDate: '2026-11-07', targetCompletionDate: '2026-11-14' });
  assert.deepEqual(targetDatesIn('Can we complete on the 14th of November?', now), { targetExchangeDate: null, targetCompletionDate: '2026-11-14' });
  assert.deepEqual(targetDatesIn('Keys on 14 November would be ideal.', now), { targetExchangeDate: null, targetCompletionDate: '2026-11-14' });
  assert.equal(targetDatesIn('The survey is on 14 November.', now), null, 'a date with no exchange or completion word is not a target');
});

test('the agent proposing a completion date sets the targets (once approved) and asks the client to agree it', async () => {
  const h = await enrolled();
  const res = await email(h, 'Both sides are keen. The seller would like to exchange on 7 November and complete on 14 November, can you make that work?', AGENT);
  const note = Object.values(res.state.notes)[0];
  const types = note.actions.map((a) => a.command?.type);
  assert.ok(types.includes('set_target_dates'), types.join(','));
  assert.ok(types.includes('confirm_with_client'), types.join(','));
  assert.ok(!types.includes('client_decision_recorded'));
  const after = await approve(h);
  assert.equal(after.state.targetExchangeDate, '2026-11-07');
  assert.equal(after.state.targetCompletionDate, '2026-11-14');
  assert.equal(after.state.clientDecisions.completion_date, undefined, 'the client has not agreed yet');
  const ask = h.ports.clientComms.sent.find((m) => m.template === 'confirm_with_client');
  assert.ok(ask);
  assert.match(String(ask!.context.claim), /happy to complete on Saturday, 14 November 2026/);
});

test('the client naming a completion date is their agreement to it', async () => {
  const h = await enrolled();
  const res = await email(h, 'We would love to complete on 14 November if the seller can do that.', CLIENT);
  const types = Object.values(res.state.notes)[0].actions.map((a) => a.command?.type);
  assert.ok(types.includes('set_target_dates') && types.includes('client_decision_recorded'), types.join(','));
  const after = await approve(h);
  assert.equal(after.state.targetCompletionDate, '2026-11-14');
  assert.equal(after.state.clientDecisions.completion_date?.decision, 'agreed');
});

test('a gift, a change of name and being away are read as the issues they are', async () => {
  const r = new DeterministicNoteReader();
  const kinds = async (t: string) => (await r.extract({ tenantId: TENANT, matterId: MATTER, text: t, kind: 'email', now: '2026-09-27' })).map((x) => (x.command as { kind?: string } | null)?.kind ?? x.command?.type);
  assert.ok((await kinds('My dad is giving us £20,000 towards the deposit.')).includes('source_of_funds'));
  assert.ok((await kinds('Also I got married in June so my name has changed to Okafor-Reid.')).includes('cdd_refresh'));
  assert.ok((await kinds('We are away from 10 October until the 20th, so nothing can be signed then.')).includes('record_availability'), 'a dated absence is a window, not a delay');
  assert.ok((await kinds('We are away for a couple of weeks from next Friday.')).includes('buyer_delay'), 'an undated one is a delay to plan around');
  assert.ok((await kinds('The seller says the replies to enquiries should be with you next week.')).includes('seller_delay'));
  assert.ok((await kinds('The broker expects the offer on Friday.')).includes('mortgage_offer_outstanding'));
});

// ───────────────────────────── context: who is away ─────────────────────────────

test('"we are away 10 to 20 October" is remembered: no chase while away, the update says so, and a target date in the window is flagged', async () => {
  const { clientOverview } = await import('../../../lib/server/engine/client-overview');
  const h = await enrolled();
  // Something is waiting on the client: the proof-of-funds form.
  await h.svc.requestProofOfFunds(TENANT, MATTER, USER, {});
  const res = await email(h, 'Hi, just to let you know we are away from 10 October until the 20th, so nothing can be signed then.', CLIENT);
  const note = Object.values(res.state.notes)[0];
  const cmd = note.actions.find((a) => a.command?.type === 'record_availability')?.command as { party: string; from: string; until: string } | undefined;
  assert.deepEqual(cmd && { party: cmd.party, from: cmd.from, until: cmd.until }, { party: 'client', from: '2026-10-10', until: '2026-10-20' });
  const after = await approve(h);
  assert.equal(after.state.availability.length, 1);

  // Before they go: the update asks for what is outstanding before the date.
  const before = clientOverview(after.state, new Date('2026-10-01T09:00:00Z'));
  assert.match(before.text, /before you go away on Saturday, 10 October 2026/i);

  // While away: no chase to the client, and the update says nothing is needed from them.
  h.ports.setNow(new Date('2026-10-14T09:00:00Z'));
  const chasesBefore = h.ports.chaser.chases.filter((c) => c.recipientRole === 'client').length;
  await h.svc.tick(TENANT, MATTER);
  assert.equal(h.ports.chaser.chases.filter((c) => c.recipientRole === 'client').length, chasesBefore, 'nobody is chased while away');
  const during = clientOverview(after.state, new Date('2026-10-14T09:00:00Z'));
  assert.match(during.text, /away until Tuesday, 20 October 2026; nothing here needs you before you are back/);
  assert.match(during.text, /When you are back we will still need/);
  // A message that already said so does not say it again for a few days, and still asks nothing of them.
  const quiet = clientOverview(await h.svc.getState(TENANT, MATTER), new Date('2026-10-14T09:00:00Z'));
  assert.doesNotMatch(quiet.text, /waiting on you|before you go away/i);

  // Back: chased as normal.
  h.ports.setNow(new Date('2026-10-26T09:00:00Z'));
  await h.svc.tick(TENANT, MATTER);
  assert.ok(h.ports.chaser.chases.filter((c) => c.recipientRole === 'client').length > chasesBefore, 'chased once back');

  // A target completion inside the window raises a delay issue naming it.
  await h.svc.run(TENANT, MATTER, { type: 'set_target_dates', actor: USER, targetCompletionDate: '2026-10-15' });
  const s = await h.svc.getState(TENANT, MATTER);
  const clash = Object.values(s.issues).find((i) => i.kind === 'buyer_delay' && /falls while the client is away/.test(i.title));
  assert.ok(clash, 'the clash is named');
});

test('the brief lists who is away, for the Q&A and the case view', async () => {
  const { caseBrief } = await import('../../../lib/server/engine/brief');
  const h = await enrolled();
  await h.svc.run(TENANT, MATTER, { type: 'record_availability', actor: USER, party: 'seller_side', from: '2026-10-01', until: '2026-10-08', note: 'Seller\'s solicitor on leave' });
  const b = caseBrief(await h.svc.getState(TENANT, MATTER), new Date('2026-09-28T09:00:00Z'));
  assert.deepEqual(b.away, [{ who: "the seller's side", from: '2026-10-01', until: '2026-10-08' }]);
  const gone = caseBrief(await h.svc.getState(TENANT, MATTER), new Date('2026-11-01T09:00:00Z'));
  assert.deepEqual(gone.away, [], 'a past window is forgotten');
});

// ───────────────────────────── price, chain, bank details, the broker ─────────────────────────────

test('the agent reporting "£5,000 off" amends the price once approved, tells the lender, and asks the client to confirm the terms', async () => {
  const h = await enrolled();
  await h.svc.run(TENANT, MATTER, { type: 'record_price_change', actor: USER, toPennies: 25_000_000, reason: 'agreed price' });
  const res = await email(h, 'Good news, the seller has agreed £5,000 off following the survey.', AGENT);
  const types = Object.values(res.state.notes)[0].actions.map((a) => a.command?.type);
  assert.ok(types.includes('record_price_change') && types.includes('confirm_with_client'), types.join(','));
  const after = await approve(h);
  assert.equal(after.state.purchasePricePennies, 24_500_000);
  assert.ok(Object.values(after.state.issues).some((i) => i.kind === 'lender_approval'), 'the lender must hear of a price change');
  const ask = h.ports.clientComms.sent.find((m) => m.template === 'confirm_with_client');
  assert.match(String(ask?.context.claim), /you have agreed a price reduction of £5,000/);
});

test('"the chain is now complete" closes the chain wait on the other side\'s word, but an agent saying it is a claim to check', async () => {
  const h = await enrolled();
  await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'chain_dependency', title: 'Top of the chain not ready', detail: null });
  const OTHER: NoteSender = { address: 'sol@otherside.example', name: 'Other Side LLP', relation: 'other_side' };
  const fromAgent = await email(h, 'Great news, the chain is now complete and everyone is ready to go.', AGENT);
  const agentCmds = Object.values(fromAgent.state.notes).at(-1)!.actions.map((a) => a.command?.type ?? 'none');
  assert.ok(!agentCmds.includes('resolve_issue'), 'an agent does not close the chain wait');
  const fromOther = await email(h, 'We confirm the chain is now complete and our client is ready to exchange.', OTHER);
  const otherCmds = Object.values(fromOther.state.notes).at(-1)!.actions.map((a) => a.command?.type ?? 'none');
  assert.ok(otherCmds.includes('resolve_issue'), otherCmds.join(','));
  const after = await approve(h);
  assert.equal(Object.values(after.state.issues).find((i) => i.kind === 'chain_dependency')?.status, 'resolved');
});

test('bank details in an email are found, with the name beside them', async () => {
  const { bankDetailsIn } = await import('../../../lib/server/engine/notes');
  assert.deepEqual(bankDetailsIn('Please send the deposit to sort code 20-45-67, account number 12345678. Account name: Other Side LLP Client Account.'), { sortCode: '204567', accountNumber: '12345678', accountName: 'Other Side LLP Client Account.' });
  assert.equal(bankDetailsIn('Our ref 12345678 and the survey is on 14/11/2026.'), null, 'a reference and a date are not a sort code');
  assert.equal(bankDetailsIn('Call me on 07700 900123.'), null);
});

test('the broker reporting a problem with the offer: the broker is asked to confirm, the client is told', async () => {
  const h = await enrolled();
  const BROKER: NoteSender = { address: 'broker@mortgages.example', name: 'Best Broker', relation: 'lender' };
  const res = await email(h, "Just a heads up, the lender has said the offer may be withdrawn following the valuation.", BROKER);
  const cmd = Object.values(res.state.notes)[0].actions.find((a) => (a.command as { kind?: string } | null)?.kind === 'mortgage_at_risk')?.command as { detail: string } | undefined;
  assert.match(cmd?.detail ?? '', /^Reported by the lender or broker/);
  await approve(h);
  assert.ok(h.ports.chaser.notices.some((n) => n.recipientRole === 'lender' && n.template === 'confirm_offer_status'), 'the broker is asked');
  assert.ok(h.ports.clientComms.sent.some((m) => m.template === 'mortgage_status_client'), 'the client is told');
});

// ───────────────────────────── replies and arrivals ─────────────────────────────

test('a reply is read for its new words only; the quoted history is not proposed again', async () => {
  const { stripQuotedReply } = await import('../../../lib/server/text');
  const reply = 'Hi, survey attached\nThanks, Pete\n\nFrom: Peter Anwyll <pete@example.com>\nSent: 27 September 2026 23:16\nTo: jo@example.com\nSubject: Your purchase — your survey report\n\nHello Jo, we would like to exchange on 7 November and complete on 14 November.';
  assert.equal(stripQuotedReply(reply), 'Hi, survey attached\nThanks, Pete');
  assert.equal(stripQuotedReply('Yes fine.\n\nOn Mon, 28 Sep 2026 at 09:00, Jo <jo@example.com> wrote:\n> can we complete on 14 November?'), 'Yes fine.');
  assert.equal(stripQuotedReply('Agreed.\n-----Original Message-----\nFrom: x'), 'Agreed.');
  assert.equal(stripQuotedReply('Just the one line, no history.'), 'Just the one line, no history.');
});

test('the survey arriving closes "survey done, report not on file" by itself', async () => {
  const h = await enrolled();
  await email(h, 'Hi, surveys are all complete', CLIENT);
  await approve(h);
  let s = await h.svc.getState(TENANT, MATTER);
  const issue = Object.values(s.issues).find((i) => i.kind === 'survey_report_outstanding')!;
  assert.equal(issue.status, 'open');
  await h.svc.surveyReceived(TENANT, MATTER, h.doc({ surveyType: 'level2', surveyor: 'J Bloggs MRICS', summary: 'Fine.', recommendations: [], confidence: 0.9 }, 'SURVEY'));
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.issues[issue.id].status, 'resolved');
  assert.notEqual(s.survey.status, 'not_started', 'the survey workstream has started');
});

test('the reply in the screenshot: only "Hi, survey attached" is read, from Outlook\'s HTML or the text fallback', async () => {
  const { htmlToText, newWordsOf } = await import('../../../lib/server/text');
  // Outlook on the web: the new words, then divRplyFwdMsg and the quoted request.
  const outlook = '<html><body><div dir="ltr">Hi, survey attached&nbsp;</div><div>Thanks, Pete</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri"><b>From:</b> Peter Anwyll &lt;pete@killerdotdev.onmicrosoft.com&gt;<br><b>Sent:</b> 27 September 2026 23:16<br><b>To:</b> peteranwyll@hotmail.com<br><b>Subject:</b> Your purchase — your survey report</font></div><div>Hello Peter, We understand your survey of 9 Arthur Road has been carried out.</div></body></html>';
  assert.equal(newWordsOf({ body: { content: outlook } }), 'Hi, survey attached\nThanks, Pete');
  // Exchange's own cut wins when it is there.
  assert.equal(newWordsOf({ uniqueBody: { content: '<div>Hi, survey attached</div>' }, body: { content: outlook } }), 'Hi, survey attached');
  // Gmail and Apple Mail.
  assert.equal(newWordsOf({ body: { content: '<div>Yes, fine.</div><div class="gmail_quote"><div>On Mon, Jo wrote:</div><blockquote>complete on 14 November?</blockquote></div>' } }), 'Yes, fine.');
  assert.equal(newWordsOf({ body: { content: '<div>Agreed.</div><blockquote type="cite">exchange on 7 November</blockquote>' } }), 'Agreed.');
  // The filed copy keeps the email's shape and reads as text, not entities.
  const doc = htmlToText(outlook);
  assert.match(doc, /^Hi, survey attached\nThanks, Pete/);
  assert.match(doc, /From: Peter Anwyll <pete@killerdotdev\.onmicrosoft\.com>\nSent: 27 September 2026 23:16/);
  assert.doesNotMatch(doc, /&nbsp;|&lt;|&gt;/);
});

test('"Hi, survey attached" with a file on it proposes nothing about a missing survey, whatever the reader says', async () => {
  const h = await enrolled();
  // A reader that makes the mistake the model made on prod.
  h.ports.noteExtractor = { name: 'overeager', extract: async () => [{ kind: 'issue', summary: 'Survey not on file', quote: 'survey attached', command: { type: 'raise_issue', kind: 'survey_report_outstanding', title: 'Survey done; ask for the report', detail: null, gate: 'none' } }] };
  const res = await h.svc.recordNote(TENANT, MATTER, { text: 'Hi, survey attached', kind: 'email', actor: USER, documentId: h.doc(null, 'EMAIL'), from: CLIENT, attachments: ['survey.pdf (read as survey)'] });
  assert.equal(blockingDecisions(res.state).filter((d) => d.kind === 'note_actions').length, 0);
  // The deterministic reader does not read "attached" as "done" either.
  const r = new DeterministicNoteReader();
  const drafts = await r.extract({ tenantId: TENANT, matterId: MATTER, text: 'Hi, survey attached', kind: 'email' });
  assert.equal(drafts.filter((d) => (d.command as { kind?: string } | null)?.kind === 'survey_report_outstanding').length, 0);
});

test('a revised document is the same document: "Contract v2 (1).pdf" and "contract-final.pdf" are versions of "Contract.pdf"; "scan.pdf" is nobody\'s name', async () => {
  const { versionKey } = await import('../../../lib/server/files');
  assert.equal(versionKey('Contract v2 (1).pdf'), versionKey('Contract.pdf'));
  assert.equal(versionKey('contract-final.pdf'), versionKey('Contract.pdf'));
  assert.equal(versionKey('Replies to enquiries_revised.docx'), versionKey('Replies to enquiries.docx'));
  assert.notEqual(versionKey('Contract.pdf'), versionKey('Contract.docx'), 'a different format is a different file');
  assert.notEqual(versionKey('Search - drainage.pdf'), versionKey('Search - local.pdf'));
  assert.equal(versionKey('scan.pdf'), null);
  assert.equal(versionKey('IMG_2041.jpg'), null);
  assert.equal(versionKey('Document (3).pdf'), null);
});

// ───────────────────────────── a withdrawn offer is never filed away ─────────────────────────────

test('"my mortgage provider has rescinded their offer" from the client raises a withdrawn-offer issue holding exchange', async () => {
  const h = await enrolled();
  const res = await email(h, 'Hi, my mortgage provider has rescinded their offer. Please advise next steps.', CLIENT);
  const note = Object.values(res.state.notes)[0];
  const cmd = note.actions.find((a) => a.command?.type === 'raise_issue')?.command as { kind: string; gate: string; title: string } | undefined;
  assert.ok(cmd, 'an issue is proposed');
  assert.equal(cmd!.kind, 'mortgage_at_risk');
  assert.equal(cmd!.gate, 'exchange');
  assert.match(cmd!.title, /^Mortgage offer withdrawn/);
  for (const t of ['The lender has withdrawn the mortgage offer.', 'Santander have cancelled our mortgage offer', 'The offer has been revoked.']) {
    const kinds = (await new DeterministicNoteReader().extract({ tenantId: TENANT, matterId: MATTER, text: t, kind: 'email' })).map((x) => (x.command as { kind?: string } | null)?.kind);
    assert.ok(kinds.includes('mortgage_at_risk'), t);
  }
});

test('an email the reader cannot place goes to a person to read and answer, never filed silently', async () => {
  const h = await enrolled();
  const documentId = h.doc(null, 'EMAIL');
  await h.svc.recordNote(TENANT, MATTER, { text: 'Hello, quick question about the garden fence, can you call me?', kind: 'email', actor: USER, documentId, from: CLIENT, surface: true });
  const s = await h.svc.getState(TENANT, MATTER);
  const d = firstDecision(s, 'note_actions');
  assert.ok(d, 'a task is raised');
  const { matterWork } = await import('../../../lib/server/engine/work');
  const item = matterWork(s, new Date()).items.find((i) => i.ref.id === d.eventId)!;
  assert.equal(item.what, "Read and reply to the client's email");
  assert.equal(item.chip, 'Client Email');
});

test('an email proposing an issue carries that issue\'s severity (the chip is coloured like the issue)', async () => {
  const h = await enrolled();
  const res = await email(h, 'Hi, my mortgage provider has rescinded their offer. Please advise next steps.', CLIENT);
  const { matterWork } = await import('../../../lib/server/engine/work');
  const { ISSUE_KIND_SPEC } = await import('../../../lib/server/engine/issues');
  const item = matterWork(res.state, new Date()).items.find((i) => i.kind === 'note_actions:email')!;
  assert.equal(item.severity, 'critical', 'a withdrawn offer is High, not the usual Medium');
  assert.equal(ISSUE_KIND_SPEC.mortgage_at_risk.severity, 'warning');
});

// ───────────────────────────── acknowledgements: the only email nobody needs to answer ─────────────────────────────

test('a pure acknowledgement needs no reply; anything that could be an answer, a question or news goes to a person', async () => {
  const { isAcknowledgement } = await import('../../../lib/server/engine/notes');
  for (const t of ['Will do, cheers', 'Thanks!', 'Great, thank you', 'Received with thanks', 'Noted, many thanks\n\nJo Client', 'Brilliant thanks x', 'Hi, thanks for the update. Kind regards, Jo', 'Cheers, no problem', 'Thank you so much for all your help!\n\nSent from my iPhone']) {
    assert.equal(isAcknowledgement(t, 'Jo Client'), true, t);
  }
  for (const t of ['Ok', 'OK great', 'Yes please', 'Fine by me', 'Sure', 'Thanks, when do we exchange?', 'Thanks - but the survey is not back yet', 'Thanks, attached is the form', "Thanks, I'll send it on the 5th", 'Will do but I am away next week', 'Thanks. The lender has pulled the offer.', 'Thanks, go ahead', 'Thanks, happy to proceed', 'Hello', 'Will call you tomorrow', 'Thanks £500 sent']) {
    assert.equal(isAcknowledgement(t, 'Jo Client'), false, t);
  }
  assert.equal(isAcknowledgement('Thanks!', 'Jo Client', 1), false, 'an email carrying a file is not just an acknowledgement');
});
