/** A firm's saved copy of a message can never send blanks, and the guard refuses a heading with nothing under it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageProblem } from '../../../lib/server/comms/templates';
import { ProductionClientComms } from '../../../lib/server/comms/client-comms';

const OLD = 'Hello {{firstName}},\n\nAn update on {{property}}: {{doneLine}}\n\nWhere everything else stands:\n{{status}}\n\nWhat happens next: {{next}}{{targetNote}}\n\nWe will keep you posted as each piece comes in; there is nothing you need to do right now.\n\n{{firmName}}';

test('the email the client received is refused: its sections are empty', () => {
  const body = 'Hello Peter,\n\nAn update on 9 Arthur Road: We have reviewed the title to the property and approved it.\n\nWhere everything else stands:\n\nWhat happens next:\n\nWe will keep you posted as each piece comes in; there is nothing you need to do right now.';
  assert.match(messageProblem({ subject: 'Your purchase', body }) ?? '', /section "Where everything else stands" is empty/);
  assert.equal(messageProblem({ subject: 'x', body: 'Hello Ann,\n\nStill to sign:\n• the transfer (TR1)\n\nJo Bloggs' }), null, 'a heading with its list is fine');
});

test("a firm's version that uses a field nothing fills is held, not sent with a blank", async () => {
  const sent: string[] = [];
  const comms = new ProductionClientComms({
    contactInfo: async () => ({ matterRef: 'R1', propertyAddress: '9 Arthur Road', firmName: 'Firm', feeEarnerName: 'Jo', feeEarnerUserId: null, clientFirstName: 'Peter', clientEmail: 'p@example.com', clientPhone: null, clientWhatsAppOptIn: false, contacts: {}, completionDate: null }),
    whatsapp: null,
    email: { send: async (i: { text: string }) => { sent.push(i.text); return { messageId: 'm1' }; } },
    mailbox: null,
    log: async () => {},
    routeToHuman: async () => {},
    matterForAddress: async () => null,
    tenantForAddress: async () => null,
    chaseMode: 'draft',
    templateOverride: async (_t: string, key: string) => (key === 'progress_update' ? { subject: '', body: OLD } : null),
  } as never);
  await assert.rejects(comms.sendStatusUpdate({ tenantId: 't', matterId: 'm', template: 'progress_update', context: { done: 'title approved', doneLine: 'We have reviewed the title.', nextStep: 'Next, the searches.' } }), /missing .*status/);
  assert.equal(sent.length, 0);
});
