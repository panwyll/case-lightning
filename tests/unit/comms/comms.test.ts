import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { render, CLIENT_UPDATES, CHASES } from '../../../lib/server/comms/templates';
import { guardClientQuestion, matchFaq, classifyClientQuestion, validateFaqReply, FAQ } from '../../../lib/server/comms/guard';
import { WhatsAppClient, parseInbound, normaliseE164 } from '../../../lib/server/comms/whatsapp';
import { ClientQaService, ProductionChaser, ProductionClientComms, type CommsDeps, type MatterContactInfo } from '../../../lib/server/comms/client-comms';
import { FakeLlm } from '../../../lib/server/engine/llm';

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

function fakeDeps(info: Partial<MatterContactInfo> = {}, opts: { whatsapp?: boolean; email?: boolean; mailbox?: boolean; chaseMode?: 'draft' | 'send' } = {}) {
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
