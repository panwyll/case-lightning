/** Every built-in template, rendered for every kind of case, reads as a letter: no leftovers, raw dates, empty salutations or the wrong kind of case. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACKS, CHASES, CLIENT_UPDATES, PARTY_NOTICES, forTransaction, render, type Template } from '../../../lib/server/comms/templates';

const VARS = {
  firstName: 'Ann', property: '14 Oak Street, Leeds LS1 2AB', address: '14 Oak Street, Leeds LS1 2AB', matterRef: 'TEST-001', firmName: 'Test & Co', feeEarner: 'Pat Lee',
  completionDate: '2026-11-30', orderedDate: '2026-09-14', searchName: 'local authority (CON29)', searchList: 'LLC1, CON29', ageWorkingDays: '12', priorChaseNote: ', despite 1 previous reminder',
  waitingOn: 'the lender', waitingFor: 'the mortgage offer', nextChaseNote: ' and will keep following it up', formUrl: 'https://example.invalid/f', noteToClient: 'A statement for the gift.',
  enquiryLine: "We've raised a question.", what: 'your replies', resend: '', lenderLine: '', valuationLine: '', done: 'title approved', doneLine: 'We have approved the title.', nextStep: 'Next we report.',
  depositAmount: ' (£30,000)', leaseholdForms: '', completionLine: ', with completion on Monday, 30 November 2026', agentName: 'Agents Ltd', solicitorName: 'Other LLP', fileList: 'the completion statement',
};
const KINDS = ['purchase', 'sale', 'remortgage', 'transfer'] as const;
/** Sent only where there is a sale or purchase (the engine never sends them on a remortgage or transfer). */
const SALE_OR_PURCHASE_ONLY = new Set(['deposit_request', 'chase_deposit', 'exchange_authority_request', 'chase_exchange_authority', 'proof_of_funds_request', 'proof_of_funds_request_again', 'chase_proof_of_funds', 'property_forms_request', 'chase_property_forms', 'report_on_title_sent', 'access_conditions']);
const all: Array<[string, Record<string, Template>]> = [['client', CLIENT_UPDATES], ['chase', CHASES], ['ack', ACKS], ['notice', PARTY_NOTICES]];

test('every template reads as a letter for every kind of case', () => {
  const problems: string[] = [];
  for (const [family, reg] of all) {
    for (const key of Object.keys(reg).filter((k) => !k.includes('__'))) {
      for (const kind of KINDS) {
        const t = forTransaction(reg, key, kind)!;
        const r = render(t, { ...VARS, transaction: kind === 'transfer' ? 'transfer of equity' : kind });
        const text = `${r.subject}\n${r.body}`;
        const bad: Array<[RegExp, string]> = [[/\{\{|\}\}/, 'a leftover'], [/\b\d{4}-\d{2}-\d{2}\b/, 'a raw date'], [/Dear\s*,|Hello\s*,/, 'an empty salutation'], [/Dear Sirs/, "'Dear Sirs'"], [/Your\s{2}|\b(of|in) (of|in)\b/, 'a broken subject'], [/ ,|,\./, 'stray punctuation']];
        if (kind !== 'purchase') bad.push([/^Your purchase/m, 'a purchase subject']);
        if ((kind === 'remortgage' || kind === 'transfer') && !SALE_OR_PURCHASE_ONLY.has(key)) bad.push([/\bexchange (contracts|around)|seller's solicitor|your purchase|your sale\b/i, 'sale or purchase words']);
        for (const [re, what] of bad) if (re.test(text)) problems.push(`${family}:${key} for a ${kind} has ${what}: ${text.slice(Math.max(0, text.search(re) - 40), text.search(re) + 50).replace(/\n/g, ' / ')}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
