import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { render, CLIENT_UPDATES, CHASES } from '../../../lib/server/comms/templates';
import { guardClientQuestion, matchFaq, classifyClientQuestion, validateFaqReply, FAQ } from '../../../lib/server/comms/guard';
import { WhatsAppClient, parseInbound, normaliseE164 } from '../../../lib/server/comms/whatsapp';
import { ClientQaService, ProductionChaser, ProductionClientComms, type CommsDeps, type MatterContactInfo } from '../../../lib/server/comms/client-comms';
import { FakeLlm } from '../../../lib/server/engine/llm';
import { caseBrief } from '../../../lib/server/engine/brief';
import { initialState } from '../../../lib/server/engine/types';

test('templates render deterministically and report missing required vars', () => {
  const r = render(CLIENT_UPDATES.search_back_all_clear, { firstName: 'Ann', property: '1 Test St', searchName: 'local authority search (CON29)', firmName: 'Firm LLP' });
  assert.equal(r.subject, 'Your purchase of 1 Test St — search received');
  assert.match(r.body, /^Hello Ann,/);
  assert.deepEqual(r.missing, []);
  const c = render(CHASES.chase_enquiry_reply, { address: '1 Test St' });
  assert.deepEqual(c.missing, ['matterRef']);
});

test('guard: hard-blocks anything transaction-specific', () => {
  const blocked = [
    'Should I pull out if the survey shows damp?',
    'The seller said the boundary fence is theirs, is that right?',
    'How much stamp duty will I pay?',
    'Is clause 4 of the contract normal?',
    'Can we complete by 14 October?',
    'My search came back with a flood risk, is that a problem?',
    'Our lender wants a retention, what do you think?',
    'I am getting a gift from my parents for the deposit',
  ];
  for (const q of blocked) assert.ok(guardClientQuestion(q).blocked, `should block: ${q}`);
  const allowed = ['What does exchange of contracts mean?', 'What happens next?', 'What is a report on title?', 'Why do you need my ID?'];
  for (const q of allowed) assert.ok(!guardClientQuestion(q).blocked, `should allow: ${q}`);
});

test('FAQ matching is conservative and process-only', () => {
  assert.equal(matchFaq('What does exchange of contracts mean?')?.entry.id, 'what_is_exchange');
  assert.equal(matchFaq('what happens next?')?.entry.id, 'what_happens_next');
  assert.equal(matchFaq('What happens at the land registry after we complete?')?.entry.id, 'what_is_registration');
  assert.equal(matchFaq('hello there'), null);
  assert.equal(classifyClientQuestion('What is a chain?').verdict, 'ALLOW');
  assert.equal(classifyClientQuestion('Is my chain going to collapse?').verdict, 'BLOCK');
  assert.equal(classifyClientQuestion('Do you like cats?').verdict, 'NO_MATCH');
});

test('validateFaqReply rejects figures, advice and padding', () => {
  const faq = FAQ[0];
  assert.ok(validateFaqReply(faq, 'Exchange is when the sale becomes legally binding on both sides; before it either side can walk away, after it both must complete on the agreed date.').ok);
  assert.ok(!validateFaqReply(faq, 'Exchange is when it becomes binding; in your case you should exchange by Friday.').ok);
  assert.ok(!validateFaqReply(faq, 'Exchange is binding and your deposit will be £25000 which is 10% of the price you agreed.').ok);
  assert.ok(!validateFaqReply(faq, 'ok').ok);
});

test('WhatsApp: signature check, challenge, inbound parsing, E.164', () => {
  const wa = new WhatsAppClient({ phoneNumberId: '1', accessToken: 't', appSecret: 'app', verifyToken: 'vt' });
  const body = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '447700900123', profile: { name: 'Ann' } }], messages: [{ from: '447700900123', id: 'wamid.1', type: 'text', timestamp: '1', text: { body: 'What happens next?' } }, { from: '447700900123', id: 'wamid.2', type: 'image' }] } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'app').update(body).digest('hex');
  assert.ok(wa.verifySignature(body, sig));
  assert.ok(!wa.verifySignature(body, 'sha256=' + '0'.repeat(64)));
  assert.equal(wa.verifyChallenge({ mode: 'subscribe', token: 'vt', challenge: 'c' }), 'c');
  assert.equal(wa.verifyChallenge({ mode: 'subscribe', token: 'x', challenge: 'c' }), null);
  const msgs = parseInbound(JSON.parse(body));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].profileName, 'Ann');
  assert.equal(normaliseE164('07700 900123'), '447700900123');
  assert.equal(normaliseE164('+44 7700 900123'), '447700900123');
});

test('WhatsApp sendText posts the Cloud API shape', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const wa = new WhatsAppClient({ phoneNumberId: '555', accessToken: 'tok' }, async (url, init) => {
    calls.push({ url, body: init.body ?? '' });
    return { status: 200, text: async () => JSON.stringify({ messages: [{ id: 'wamid.x' }] }) };
  });
  const r = await wa.sendText('07700900123', 'hi');
  assert.equal(r.messageId, 'wamid.x');
  assert.match(calls[0].url, /graph\.facebook\.com\/v21\.0\/555\/messages$/);
  assert.match(calls[0].body, /"to":"447700900123"/);
});

function fakeDeps(info: Partial<MatterContactInfo> = {}, opts: { whatsapp?: boolean; email?: boolean; mailbox?: boolean; chaseMode?: 'draft' | 'send'; brief?: CommsDeps['briefFor'] } = {}) {
  const sentWa: string[] = [];
  const sentEmail: Array<{ to: string; subject: string }> = [];
  const drafts: Array<{ to: string; subject: string }> = [];
  const logs: Array<{ direction: string; status: string; template: string | null }> = [];
  const routed: string[] = [];
  const deps: CommsDeps = {
    contactInfo: async () => ({
      matterRef: 'M-1', propertyAddress: '1 Test St', firmName: 'Firm LLP', feeEarnerName: 'Jo Bloggs', feeEarnerUserId: 'u1', clientFirstName: 'Ann', clientEmail: 'ann@example.com', clientPhone: '447700900123', clientWhatsAppOptIn: true,
      contacts: { seller_solicitor: { email: 'other@side.law', name: 'Other Side' } }, completionDate: null, ...info,
    }),
    whatsapp: opts.whatsapp === false ? null : { sendText: async (_to, body) => { sentWa.push(body); return { messageId: 'wa-1' }; } },
    email: opts.email ? { send: async ({ to, subject }) => { sentEmail.push({ to, subject }); return { messageId: 'em-1' }; } } : null,
    mailbox: opts.mailbox === false ? null : { send: async (_u, to, subject) => { sentEmail.push({ to, subject }); return { messageId: 'gm-1' }; }, draft: async (_u, to, subject) => { drafts.push({ to, subject }); return { messageId: 'draft-1' }; } },
    log: async (i) => { logs.push({ direction: i.direction, status: i.status, template: i.template }); },
    routeToHuman: async (i) => { routed.push(i.title); },
    matterForAddress: async () => ({ matterId: 'm1' }),
    tenantForAddress: async (addr) => (addr === '447700900123' ? 't1' : null),
    chaseMode: opts.chaseMode ?? 'draft',
    briefFor: opts.brief,
  };
  return { deps, sentWa, sentEmail, drafts, logs, routed };
}

test('status updates go to WhatsApp with opt-in, else email; the report on title is email-only', async () => {
  const f = fakeDeps();
  const comms = new ProductionClientComms(f.deps);
  const r = await comms.sendStatusUpdate({ tenantId: 't1', matterId: 'm1', template: 'search_back_all_clear', context: { payload: { searchType: 'CON29' } } });
  assert.equal(r.channel, 'whatsapp');
  assert.match(f.sentWa[0], /local authority search \(CON29\)/);
  const g = fakeDeps({ clientWhatsAppOptIn: false });
  const r2 = await new ProductionClientComms(g.deps).sendStatusUpdate({ tenantId: 't1', matterId: 'm1', template: 'exchanged', context: { payload: { completionDate: '2026-11-27' } } });
  assert.equal(r2.channel, 'email');
  assert.equal(g.sentEmail[0].to, 'ann@example.com');
  const report = await comms.sendReportOnTitle({ tenantId: 't1', matterId: 'm1', draftDocument: { id: 'd', tenantId: 't1', matterId: 'm1', docType: 'REPORT_ON_TITLE_DRAFT', fileName: 'rot.txt', webUrl: null, extractedFacts: { content: 'REPORT…' }, extractionConfidence: null } });
  assert.equal(report.channel, 'email');
  assert.equal(f.sentWa.length, 1, 'the report never goes to WhatsApp');
  await assert.rejects(new ProductionClientComms(fakeDeps({ clientEmail: null, clientPhone: null }).deps).sendStatusUpdate({ tenantId: 't1', matterId: 'm1', template: 'completed', context: {} }), /No client channel/);
});

test('chases: draft by default (worklist item), send when configured; client ID chase uses the client channel', async () => {
  const f = fakeDeps();
  const drafted: string[] = [];
  f.deps.onChaseDrafted = async (i) => { drafted.push(i.title); };
  const chaser = new ProductionChaser(f.deps);
  const r = await chaser.sendChase({ tenantId: 't1', matterId: 'm1', recipientRole: 'seller_solicitor', template: 'chase_enquiry_reply', context: { subject: 'E1', openedAt: '2026-09-14T09:00:00Z', ageWorkingDays: 6, priorChases: 1 } });
  assert.equal(r.messageId, 'draft-1');
  assert.equal(f.drafts[0].to, 'other@side.law');
  assert.match(drafted[0], /Chase drafted/);
  const s = fakeDeps({}, { chaseMode: 'send' });
  const r2 = await new ProductionChaser(s.deps).sendChase({ tenantId: 't1', matterId: 'm1', recipientRole: 'seller_solicitor', template: 'chase_enquiry_reply', context: { subject: 'E1', openedAt: '2026-09-14T09:00:00Z', ageWorkingDays: 6 } });
  assert.equal(r2.messageId, 'gm-1');
  assert.equal(s.sentEmail[0].to, 'other@side.law');
  const id = await new ProductionChaser(f.deps).sendChase({ tenantId: 't1', matterId: 'm1', recipientRole: 'client', template: 'chase_id_documents', context: { subject: '', openedAt: '2026-09-14T09:00:00Z', ageWorkingDays: 3 } });
  assert.equal(id.channel, 'whatsapp');
  await assert.rejects(new ProductionChaser(fakeDeps({ contacts: {} }).deps).sendChase({ tenantId: 't1', matterId: 'm1', recipientRole: 'seller_solicitor', template: 'chase_enquiry_reply', context: {} }), /No seller solicitor email/);
});

test('acknowledgements: the other side is emailed at once from the fee-earner mailbox; the client hears on their channel; nobody to tell means nothing sent', async () => {
  const f = fakeDeps();
  const chaser = new ProductionChaser(f.deps);
  const r = await chaser.sendAcknowledgement({ tenantId: 't1', matterId: 'm1', recipientRole: 'seller_solicitor', what: 'your replies to our enquiries', forEventType: 'enquiry_reply_received' });
  assert.equal(r?.messageId, 'gm-1', 'sent, never drafted, whatever the chase mode');
  assert.equal(f.sentEmail[0].to, 'other@side.law');
  assert.match(f.sentEmail[0].subject, /received, thank you/);
  assert.equal(f.logs.at(-1)?.template, 'ack_counterparty');
  const c = await chaser.sendAcknowledgement({ tenantId: 't1', matterId: 'm1', recipientRole: 'client', what: 'the survey report', forEventType: 'survey_received' });
  assert.equal(c?.channel, 'whatsapp');
  const none = await new ProductionChaser(fakeDeps({ contacts: {} }).deps).sendAcknowledgement({ tenantId: 't1', matterId: 'm1', recipientRole: 'seller_solicitor', what: 'x', forEventType: 'enquiry_reply_received' });
  assert.equal(none, null);
  const off = fakeDeps(); off.deps.ackMode = 'off';
  assert.equal(await new ProductionChaser(off.deps).sendAcknowledgement({ tenantId: 't1', matterId: 'm1', recipientRole: 'seller_solicitor', what: 'x', forEventType: 'enquiry_reply_received' }), null);
});

test('client Q&A: FAQ questions are answered (validated rephrase or verbatim); everything else is routed to a person with a holding reply', async () => {
  const f = fakeDeps();
  const qa = new ClientQaService(f.deps, new FakeLlm(() => ({ reply: 'Exchange is the moment the purchase becomes legally binding for both sides — before it either party can still walk away, after it everyone is committed to the completion date.' })), { model: 'fake' });
  const a = await qa.handleInbound({ fromAddress: '447700900123', channel: 'whatsapp', text: 'What does exchange mean?' });
  assert.equal(a?.verdict, 'ANSWERED');
  assert.equal(a?.faqId, 'what_is_exchange');
  assert.match(f.sentWa[0], /legally binding/);
  assert.deepEqual(f.routed, []);

  const bad = new ClientQaService(f.deps, new FakeLlm(() => ({ reply: 'In your case you should exchange by Friday and pay £25000.' })), { model: 'fake' });
  const b = await bad.handle({ tenantId: 't1', matterId: 'm1', fromAddress: '447700900123', channel: 'whatsapp', text: 'What is completion?' });
  assert.equal(b.reply, FAQ.find((x) => x.id === 'what_is_completion')!.answer, 'invalid rephrase → verbatim FAQ answer');

  const c = await qa.handleInbound({ fromAddress: '447700900123', channel: 'whatsapp', text: 'Should I pull out because of the flood risk on my search?' });
  assert.equal(c?.verdict, 'ROUTED_TO_HUMAN');
  assert.match(c!.reply, /Jo Bloggs will come back to you personally/);
  assert.equal(f.routed.length, 1);
  assert.ok(f.logs.some((l) => l.direction === 'IN' && l.status === 'ROUTED_TO_HUMAN'));

  assert.equal(await qa.handleInbound({ fromAddress: '440000000000', channel: 'whatsapp', text: 'hi' }), null, 'unknown numbers are ignored');
});


/**
 * "Any update?" is the commonest message a client sends, and the one a leaflet answers
 * worst. It is answered from the matter's own state — but only when the engine says a
 * machine may answer at all.
 */
test('client Q&A: a status question is answered from the case, and routed to a person when the case is not one a machine should describe', async () => {
  const base = { ...initialState('t1', 'm1'), enrolled: true, requiredSearches: ['CON29' as const], stage: 'pre_contract' as const };
  base.stageHistory = [{ stage: 'instruction', at: new Date(Date.now() - 20 * 86_400_000).toISOString(), seq: 1 }, { stage: 'pre_contract', at: new Date(Date.now() - 14 * 86_400_000).toISOString(), seq: 2 }];
  base.idCheck = { ...base.idCheck, status: 'cleared' };
  base.waits = [{ key: 'search', subject: 'CON29', openedAt: new Date(Date.now() - 18 * 86_400_000).toISOString(), openedBySeq: 3, closedAt: null, chasesSentAt: [new Date(Date.now() - 86_400_000).toISOString()], escalations: [] }];

  const healthy = fakeDeps({}, { brief: async () => caseBrief(base) });
  const qa = new ClientQaService(healthy.deps, null, { model: 'fake' });
  const a = await qa.handle({ tenantId: 't1', matterId: 'm1', fromAddress: '447700900123', channel: 'whatsapp', text: 'Any update?' });
  assert.equal(a.verdict, 'ANSWERED');
  assert.equal(a.source, 'case_status', 'from the case, not the FAQ');
  assert.match(a.reply, /waiting for the local authority and search providers/);
  assert.match(a.reply, /We chased yesterday/);
  assert.match(a.reply, /nothing you need to do/);
  assert.deepEqual(healthy.routed, []);

  // The same question on a matter with a legal problem on it fetches a person instead.
  const blocked = { ...base, issues: { 'ISS-1': { id: 'ISS-1', kind: 'title_defect' as const, title: 'Restriction in the register', detail: null, gate: 'exchange' as const, status: 'open' as const, raisedAt: new Date().toISOString(), raisedBy: 'u1', raisedAtStage: 'pre_contract' as const, updatedAt: new Date().toISOString(), sourceDocumentId: null, resolution: null, resolvedAt: null, resolvedBy: null, origin: null, party: null, costPennies: null, paidBy: null, enquiryIds: [], severity: 'warning' as const, history: [], causedBy: null } } };
  const held = fakeDeps({}, { brief: async () => caseBrief(blocked) });
  const qa2 = new ClientQaService(held.deps, null, { model: 'fake' });
  const b = await qa2.handle({ tenantId: 't1', matterId: 'm1', fromAddress: '447700900123', channel: 'whatsapp', text: 'any news?' });
  assert.equal(b.verdict, 'ROUTED_TO_HUMAN');
  assert.match(held.routed[0], /asked for an update/);
  assert.doesNotMatch(b.reply, /Restriction/, 'the holding reply never mentions the problem');
});
