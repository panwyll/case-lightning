/**
 * Every message the engine can send, as one catalogue: what triggers it, who it goes to,
 * which template carries it and which trust level governs it. The Rules page lists it;
 * Email Templates uses it to say what each Engine template is for and which placeholders
 * it must keep.
 */
import { ACKNOWLEDGE, CLIENT_UPDATE_TEMPLATES } from './service';
import { DEFAULT_SLA } from './sla';
import { WAIT_KEYS, levelFor, levelKey, type LevelConfig, type WaitKey } from './types';
import { ACKS, CHASES, CLIENT_UPDATES, PARTY_NOTICES } from '../comms/templates';

export const RECIPIENT: Record<string, string> = { seller_solicitor: "Other side's solicitor", search_provider: 'Search provider', lender: 'Lender', client: 'Client', id_provider: 'ID provider', hmlr: 'HM Land Registry', estate_agent: 'Estate agent' };
export const WAIT_LABEL: Record<WaitKey, string> = { mortgage_offer: 'News of the mortgage offer from the client', survey: 'Whether the client is having a survey', contract_pack: "Draft contract pack from the seller's solicitor", id_check: 'ID documents from the client', search: 'Search result from the provider', enquiry: "Replies from the other side's solicitor", funds: 'Completion funds', registration: 'Registration at HM Land Registry', proof_of_funds: 'Proof-of-funds form from the client', management_pack: 'Management pack', property_forms: 'Property forms from the client', redemption: 'Redemption statement from the lender', lender_consent: "Lender's consent", discharge: 'Discharge from the lender', signed_documents: 'Signed documents from the client', deposit: 'The deposit from the client', client_decision: "The client's decision", insurance: 'Buildings insurance from the client' };
const EVENT_LABEL: Record<string, string> = {
  enquiry_reply_received: 'Replies to our enquiries arrive', buyer_enquiries_received: "The buyer's enquiries arrive", survey_received: 'A survey arrives', specialist_report_received: 'A specialist report arrives', property_forms_received: 'The property forms come back', proof_of_funds_submitted: 'The proof-of-funds form is submitted', mortgage_offer_received: 'The mortgage offer arrives',
  search_ordered: 'Searches are ordered', search_cleared: 'A search comes back clear', search_flagged: 'A search comes back and needs review', enquiry_raised: 'Enquiries are raised', mortgage_offer_cleared: 'The offer is checked and clear', report_on_title_sent: 'The report on title is sent', contracts_exchanged: 'Contracts are exchanged', completion_confirmed: 'Completion happens', ap1_confirmed: 'Registration is confirmed',
};

export function engineMessages(levels: LevelConfig) {
  const rows: Array<{ id: string; kind: 'acknowledgement' | 'update' | 'chase' | 'request'; when: string; to: string; subject: string; template: string; levelKey: string; level: string }> = [];
  for (const [ev, r] of Object.entries(ACKNOWLEDGE)) {
    if (!r) continue;
    const t = r.recipient === 'client' ? ACKS.ack_client : ACKS.ack_counterparty;
    rows.push({ id: `ack:${ev}`, kind: 'acknowledgement', when: EVENT_LABEL[ev] ?? ev.replace(/_/g, ' '), to: RECIPIENT[r.recipient], subject: t.subject, template: t.key, levelKey: levelKey('acknowledgement', r.recipient), level: levelFor(levels, 'acknowledgement', r.recipient) });
  }
  rows.push({ id: 'req:id_check', kind: 'request', when: 'A case is enrolled', to: 'Client, via the ID provider', subject: 'Identity check request', template: 'id_check_request', levelKey: levelKey('client_update', 'id_check_request'), level: levelFor(levels, 'client_update', 'id_check_request') });
  rows.push({ id: 'req:proof_of_funds', kind: 'request', when: 'A purchase is enrolled and firm policy requires proof of funds', to: 'Client', subject: CLIENT_UPDATES.proof_of_funds_request.subject, template: 'proof_of_funds_request', levelKey: levelKey('client_update', 'proof_of_funds_request'), level: levelFor(levels, 'client_update', 'proof_of_funds_request') });
  for (const [ev, tpl] of Object.entries(CLIENT_UPDATE_TEMPLATES)) {
    if (!tpl) continue;
    const t = CLIENT_UPDATES[tpl];
    rows.push({ id: `update:${ev}`, kind: 'update', when: EVENT_LABEL[ev] ?? ev.replace(/_/g, ' '), to: 'Client', subject: t?.subject ?? tpl, template: tpl, levelKey: levelKey('client_update', tpl), level: levelFor(levels, 'client_update', tpl) });
  }
  rows.push({ id: 'update:chase_update', kind: 'update', when: 'We chase someone on their behalf', to: 'Client (and the agent)', subject: CLIENT_UPDATES.chase_update.subject, template: 'chase_update', levelKey: levelKey('client_update', 'chase_update'), level: levelFor(levels, 'client_update', 'chase_update') });
  // Requests the engine sends itself when a step falls due (service.ts FIRST_REQUESTS and automaticSteps).
  const REQUESTS: Array<[string, string, string]> = [
    ['request_contract_pack', 'A purchase leaves instruction', "Seller's solicitor"],
    ['request_management_pack', 'A leasehold purchase reaches pre-contract', "Seller's solicitor"],
    ['request_redemption_statement', 'A sale or remortgage of a mortgaged property is enrolled', 'Lender'],
    ['request_lender_consent', 'A transfer of equity of a mortgaged property is enrolled', 'Lender'],
    ['request_discharge', 'The mortgage is redeemed on completion', 'Lender'],
    ['enquiries_to_seller_solicitor', 'An enquiry is raised', "Seller's solicitor"],
    ['exchanged_agent', 'Contracts are exchanged', 'Estate agent'],
    ['completed_agent', 'Completion', 'Estate agent'],
    ['property_forms_request', 'A sale is enrolled', 'Client'],
    ['deposit_request', 'The contract is approved (purchase)', 'Client'],
    ['completion_statement', 'The completion statement is sent', 'Client'],
    ['ownership_basis_request', 'Joint buyers are enrolled, or a second buyer joins', 'Client'],
    ['exchange_authority_request', 'The case reaches pre-exchange', 'Client'],
    ['buildings_insurance_request', 'Contracts are exchanged on a lender-funded purchase', 'Client'],
    ['balance_request', 'Completion funds are requested from the client', 'Client'],
  ];
  for (const [tpl, when, to] of REQUESTS) {
    if (rows.some((r) => r.template === tpl)) continue;
    const t = CLIENT_UPDATES[tpl] ?? PARTY_NOTICES[tpl];
    const client = to === 'Client';
    rows.push({ id: `req:${tpl}`, kind: 'request', when, to, subject: t?.subject ?? tpl, template: tpl, levelKey: levelKey(client ? 'client_update' : 'chase', tpl), level: levelFor(levels, client ? 'client_update' : 'chase', tpl) });
  }
  for (const k of WAIT_KEYS) {
    const r = DEFAULT_SLA[k];
    const t = CHASES[r.template];
    rows.push({ id: `chase:${k}`, kind: 'chase', when: `${WAIT_LABEL[k]} is overdue (timer)`, to: RECIPIENT[r.recipientRole], subject: t?.subject ?? r.template, template: r.template, levelKey: levelKey('chase', k), level: levelFor(levels, 'chase', k) });
  }
  return rows;
}


export interface MessageInfo { when: string; to: string; /** Update, Chaser, Acknowledgement or Notice: the editor's subsections. */ kind?: string; requires: string[]; /** every placeholder the built-in wording uses, for the editor's insert row */ vars: string[] }

const varsOf = (t: { subject: string; body: string } | undefined): string[] => (t ? Array.from(new Set(`${t.subject}\n${t.body}`.match(/\{\{(\w+)\}\}/g) ?? [])).map((s) => s.slice(2, -2)) : []);

/** By template key: what an Engine email template is for, and the placeholders it must keep for the send to work. */
export function messageInfo(): Record<string, MessageInfo> {
  const out: Record<string, MessageInfo> = {};
  const all = { ...CLIENT_UPDATES, ...CHASES, ...PARTY_NOTICES, ...ACKS };
  for (const m of engineMessages({} as LevelConfig)) {
    const t = all[m.template];
    const prev = out[m.template];
    out[m.template] = { when: prev ? `${prev.when}; ${m.when.charAt(0).toLowerCase()}${m.when.slice(1)}` : m.when, to: m.to, requires: t?.requires ?? [], vars: varsOf(t) };
  }
  // A version for another kind of case says when it is used: the base's trigger, on that kind of case.
  const KIND: Record<string, string> = { sale: 'a sale', remortgage: 'a remortgage', transfer: 'a transfer of equity' };
  for (const [k, t] of Object.entries(all)) {
    const [base, kind] = k.split('__');
    if (!out[k] && kind && out[base]) out[k] = { ...out[base], when: `${out[base].when} (on ${KIND[kind] ?? kind})`, requires: t.requires, vars: varsOf(t) };
  }
  for (const [k, t] of Object.entries(all)) if (!out[k]) out[k] = { vars: varsOf(t), when: k === 'qa_routed_to_human' ? 'A client question the assistant cannot answer safely' : k === 'chase_update_agent' ? 'We chase someone on the client\'s behalf' : 'Used by the engine', to: t.channel === 'client' ? 'Client' : k === 'chase_update_agent' ? 'Estate agent' : 'The party', requires: t.requires };
  const KINDS: Array<[Record<string, unknown>, string]> = [[ACKS, 'Acknowledgements'], [CHASES, 'Chasers'], [PARTY_NOTICES, 'Notices'], [CLIENT_UPDATES, 'Updates']];
  for (const [k, v] of Object.entries(out)) v.kind = KINDS.find(([set]) => k in set)?.[1] ?? 'Updates';
  return out;
}
