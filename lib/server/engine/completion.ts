/**
 * Completion contracts: what a person must supply to record a milestone by hand.
 *
 * A bare button records nothing but a click. Each contracted command declares the
 * evidence its completion carries — a document of the right kind, a figure, a date, a
 * reference, who confirmed — and the machine refuses the command without it. The Work
 * tab renders a completion sheet from the same contract, so the UI and the server can't
 * drift. Keys of figures/dates/text fields are the command's own fields, so the sheet
 * fills the command directly; `completion` on the command carries the rest.
 */
import type { CommandType } from './machine';

export type FieldKind = 'money' | 'date' | 'datetime' | 'text' | 'names' | 'flag';
export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  hint?: string;
}
export interface ChecklistItem {
  key: string;
  label: string;
}
export interface CompletionContract {
  /** The button label, in Title Case. */
  label: string;
  /** Classifier roles or doc types that satisfy the document slot; empty = any document. */
  documentRoles?: string[];
  documentLabel?: string;
  documentRequired?: boolean;
  fields?: Field[];
  /** Every item must be ticked. */
  checklist?: ChecklistItem[];
  /** Who confirmed, how, when. */
  party?: { label: string };
  /** What the sheet says under its title: what recording this means. */
  effect: string;
}

export interface Completion {
  documentId?: string | null;
  checklist?: Record<string, boolean> | null;
  party?: { who: string; channel: string; at: string } | null;
  note?: string | null;
  /** The person confirms they opened the document before recording. */
  readDocument?: boolean | null;
}

const money = (key: string, label: string, required = true): Field => ({ key, label, kind: 'money', required });
const date = (key: string, label: string, required = true): Field => ({ key, label, kind: 'date', required });
const text = (key: string, label: string, required = true, hint?: string): Field => ({ key, label, kind: 'text', required, hint });
const flag = (key: string, label: string): Field => ({ key, label, kind: 'flag', required: false });
const names = (key: string, label: string): Field => ({ key, label, kind: 'names', required: true, hint: 'Comma-separated' });

export const COMPLETION_CONTRACTS: Partial<Record<CommandType, CompletionContract>> = {
  contract_pack_sent: { label: 'Contract Pack Sent', documentRoles: ['contract', 'CONTRACT', 'CONTRACT_PACK'], documentLabel: 'The draft contract sent', documentRequired: true, effect: "Records the pack as out; the buyer's enquiries can now arrive." },
  contract_approved: { label: 'Contract Approved', documentRoles: ['contract', 'CONTRACT'], documentLabel: 'The approved contract', documentRequired: true, fields: [text('note', 'Approved subject to', false)], effect: 'Marks the contract as approved for signature.' },
  signed_contract_held: { label: 'Signed Contract Held', documentRoles: ['contract', 'CONTRACT', 'SIGNED_CONTRACT'], documentLabel: 'The signed contract', documentRequired: true, checklist: [{ key: 'every_signatory', label: 'Every client has signed' }, { key: 'dated', label: 'Left undated for exchange' }], effect: 'The signed part is on file, ready to exchange.' },
  deposit_received: { label: 'Deposit Received', documentLabel: 'Remittance or client-account receipt', fields: [money('amountPennies', 'Amount received')], effect: 'Records the deposit as held on client account.' },
  contracts_exchanged: { label: 'Contracts Exchanged', fields: [date('completionDate', 'Completion date agreed'), { key: 'exchangedAt', label: 'Exchanged at', kind: 'datetime', required: false }], checklist: [{ key: 'formula', label: 'Exchanged under a Law Society formula' }, { key: 'deposit_held', label: 'Deposit held or sent as agreed' }], effect: 'The contract is binding from this moment. Completion date and deposit become contractual.' },
  completion_statement_generated: { label: 'Completion Statement Produced', documentRoles: ['COMPLETION_STATEMENT', 'completion_statement'], documentLabel: 'The completion statement', documentRequired: true, fields: [money('balancePennies', 'Balance on the statement')], effect: 'The statement is on file; funds can be requested against it.' },
  funds_requested: { label: 'Request Funds', fields: [money('amountPennies', 'Amount to ask for')], effect: 'Asks for the money to our verified client account. What arrives is checked against this figure: short holds completion, over is returned.' },
  funds_received: { label: 'Funds Received', documentLabel: 'Bank receipt', fields: [money('amountPennies', 'Amount received'), text('remitter', 'Name on the sending account', false), flag('uncleared', 'Not cleared yet (a cheque, or held by the bank)')], effect: 'Checked against what was asked for: short holds completion, over is owed back. Money from an account not seen in the source-of-funds evidence raises an AML issue.' },
  charge_statement_received: { label: 'Redemption Figure Received', documentLabel: 'The redemption statement', fields: [money('redemptionPennies', 'Redemption figure'), date('validUntil', 'Valid until', false)], effect: 'The figure goes on the statement and is checked with the others against the price.' },
  charge_redeemed: { label: 'Charge Paid Off', fields: [money('amountPennies', 'Amount paid')], effect: 'Paid from the proceeds; the discharge is chased until it arrives.' },
  charge_discharged: { label: 'Discharge Received', documentRoles: ['DS1', 'EDS1', 'DISCHARGE', 'discharge'], documentLabel: 'DS1, e-DS1 or the release', fields: [text('reference', 'Reference', false)], effect: 'The charge is off the title.' },
  undertaking_given: { label: 'Undertaking Given', fields: [text('to', 'Given to'), text('terms', 'Terms')], effect: "Our firm is bound to redeem every charge and send the discharges: completion can go ahead." },
  completion_information_received: { label: 'Completion Information Received', documentRoles: ['TA13', 'COMPLETION_INFORMATION'], documentLabel: 'The TA13 replies', fields: [flag('undertakingToRedeem', "The seller's solicitor undertakes to redeem every charge")], effect: "Completion can go ahead once the seller's charges are covered by their undertaking." },
  record_sdlt_facts: { label: 'SDLT Answers', fields: [flag('mainResidence', "It will be the buyers' only or main home"), flag('anyEverOwned', 'A buyer has owned a home before, anywhere in the world'), flag('anyOwnsOther', 'At the end of completion day a buyer (or their spouse) will own another home worth £40,000 or more'), flag('replacing', 'A buyer is selling their main home'), flag('replacingFirst', 'That sale completes on or before this purchase'), flag('anyNonResident', 'A buyer spent fewer than 183 days in the UK in the last 12 months'), flag('mixedUse', 'Part of it is genuinely non-residential'), flag('wales', 'The property is in Wales (Land Transaction Tax)'), money('debtAssumedPennies', 'Mortgage debt taken on (transfer of equity only)', false)], effect: 'The basis is worked out from these answers, with the reason for each part, and the estimate follows.' },
  record_cgt_facts: { label: 'CGT Answers', fields: [flag('mainResidenceThroughout', "It has been the client's only or main home throughout"), flag('ukResident', 'The client is UK resident for tax')], effect: 'Either answer "no" raises a flag to tell the client about the 60-day report. Never advice.' },
  completion_payment_sent: { label: 'Completion Money Sent', fields: [text('reference', 'CHAPS reference'), { key: 'sentAt', label: 'Sent at', kind: 'datetime', required: false }], effect: "Recorded against the authorised payment; after 2pm on the day it counts as late completion (SCS 6.1.2)." },
  retention_released: { label: 'Retention Released', documentLabel: "The lender's release", fields: [money('amountPennies', 'Amount released')], effect: 'Passed on to whoever paid for the works (usually the client); the file can close.' },
  final_bill_delivered: { label: 'Final Bill Sent', documentLabel: 'The bill', fields: [money('amountPennies', 'Bill total (with VAT and disbursements)')], effect: 'Fees may be taken from client money once the bill is delivered; the file can close.' },
  register_checked: { label: 'Register Checked', documentRoles: ['TITLE_REGISTER', 'OFFICIAL_COPY', 'title'], documentLabel: 'The new official copy', fields: [flag('wrong', 'Something on it is wrong (a name, a charge missing or out of order, a seller\'s charge left, no Form A for tenants in common)'), text('note', 'What is wrong', false), flag('lenderTold', 'Registration confirmed to the lender, if it asks')], effect: 'The file can close once the register says what it should; a mistake becomes an issue to put right.' },
  ap1_cancelled: { label: 'Application Cancelled', documentLabel: "HM Land Registry's notice", fields: [text('reason', 'Why HM Land Registry cancelled it')], effect: 'Priority is lost: a fresh priority search and a new application, and the lender told.' },
  requisition_extended: { label: 'More Time Agreed', documentLabel: "HM Land Registry's agreement", fields: [date('deadline', 'New reply date'), text('note', 'What is awaited and what HM Land Registry agreed')], effect: 'The new date replaces the old one; the timer watches it.' },
  seller_discharge_received: { label: "Seller's DS1 Received", documentRoles: ['DS1', 'EDS1', 'DISCHARGE', 'discharge'], documentLabel: 'The DS1 or confirmation of the e-DS1', fields: [text('reference', 'Reference', false)], effect: "The seller's charge comes off; their solicitor's undertaking is done." },
  longstop_date_recorded: { label: 'Long-Stop Date', fields: [date('date', 'Long-stop date')], effect: 'Watched: past it either side may rescind, and the offer must still be valid.' },
  refund_paid: { label: 'Refund Sent', fields: [text('reference', 'Payment reference')], effect: 'Records the money as returned to the account it came from.' },
  completion_confirmed: { label: 'Completion Confirmed', fields: [{ key: 'completedAt', label: 'Completed at', kind: 'datetime', required: false }], checklist: [{ key: 'monies_sent', label: "Completion monies sent and receipt confirmed by the other side" }, { key: 'keys', label: 'Keys released / vacant possession confirmed' }], effect: 'The transaction has completed. The registration clock starts.' },
  mortgage_deed_executed: { label: 'Mortgage Deed Signed', documentRoles: ['MORTGAGE_DEED', 'mortgage_deed', 'DEED', 'SIGNED_DEED'], documentLabel: 'Scan of the signed mortgage deed', documentRequired: true, checklist: [{ key: 'every_borrower', label: 'Every borrower has signed' }, { key: 'witnessed', label: 'Witnessed by an independent adult' }, { key: 'original_held', label: 'The wet-ink original is with us (or it was signed electronically)' }], effect: 'The deed is held for completion.' },
  certificate_of_title_sent: { label: 'Certificate of Title Sent', documentRoles: ['CERTIFICATE_OF_TITLE', 'certificate_of_title'], documentLabel: 'The certificate sent to the lender', fields: [date('completionDate', 'Completion date on the certificate')], effect: 'The lender is asked to release the advance for the completion date.' },
  transfer_deed_executed: { label: 'Transfer Signed', documentRoles: ['TR1', 'TRANSFER_DEED', 'transfer_deed', 'DEED', 'SIGNED_DEED'], documentLabel: 'Scan of the signed TR1', documentRequired: true, fields: [names('parties', 'Who signed')], checklist: [{ key: 'witnessed', label: 'Witnessed by an independent adult' }, { key: 'original_held', label: 'The wet-ink original is with us (or it was signed electronically)' }], effect: 'The transfer is executed and held for completion.' },
  deed_of_trust_executed: { label: 'Declaration of Trust Signed', documentRoles: ['DEED_OF_TRUST', 'deed_of_trust', 'DEED', 'SIGNED_DEED'], documentLabel: 'Scan of the signed declaration', documentRequired: true, fields: [names('parties', 'Who signed'), text('shares', 'Shares', false, 'e.g. 60/40')], checklist: [{ key: 'witnessed', label: 'Witnessed by an independent adult' }, { key: 'original_held', label: 'The wet-ink original is with us (or it was signed electronically)' }], effect: "Records how the clients hold the property between themselves." },
  property_forms_received: { label: 'Property Forms Received', documentRoles: ['TA6', 'TA10', 'TA7', 'PROPERTY_FORMS', 'property_forms'], documentLabel: 'The completed forms', documentRequired: true, checklist: [{ key: 'TA6', label: 'TA6 property information' }, { key: 'TA10', label: 'TA10 fittings and contents' }], effect: 'The forms go into the contract pack.' },
  enquiry_replies_sent: { label: 'Replies Sent', documentRoles: ['ENQUIRY_REPLIES', 'enquiry_replies'], documentLabel: 'The replies as sent', effect: "The buyer's enquiries are answered; the wait on our side closes." },
  redemption_statement_received: { label: 'Redemption Statement Received', documentRoles: ['REDEMPTION_STATEMENT', 'redemption_statement'], documentLabel: 'The statement', documentRequired: true, fields: [money('redemptionPennies', 'Redemption figure'), date('validUntil', 'Valid until', false), money('dailyInterestPennies', 'Daily interest', false)], effect: 'The figure the completion statement is built on.' },
  mortgage_redeemed: { label: 'Mortgage Redeemed', documentLabel: "Lender's confirmation", fields: [money('amountPennies', 'Amount paid')], effect: 'The existing charge is paid off; the discharge is awaited.' },
  discharge_confirmed: { label: 'Discharge Confirmed', documentRoles: ['DS1', 'EDS1', 'DISCHARGE', 'discharge'], documentLabel: 'DS1 or e-DS1', documentRequired: true, fields: [text('reference', "Lender's reference", false)], effect: 'The charge is off the title.' },
  lender_consent_received: { label: 'Lender Consent Received', documentRoles: ['LENDER_CONSENT', 'lender_consent'], documentLabel: "The lender's consent letter", documentRequired: true, fields: [text('conditions', 'Conditions of consent', false)], effect: 'The lender agrees to the transfer.' },
  bankruptcy_search_clear: { label: 'Bankruptcy Search Clear', documentRoles: ['K16', 'BANKRUPTCY_SEARCH'], documentLabel: 'The K16 result', documentRequired: false, fields: [names('subjects', 'Searched against')], effect: 'No entries against the borrowers; the lender can complete.' },
  priority_search_made: { label: 'Priority Search Made', documentRoles: ['OS1', 'OS2', 'PRIORITY_SEARCH'], documentLabel: 'The OS1 result', documentRequired: false, fields: [date('expiresAt', 'Priority period ends')], effect: 'Our client has priority for registration until the date; the AP1 must be lodged before it ends.' },
  buildings_insurance_confirmed: { label: 'Buildings Insurance Confirmed', documentRoles: ['INSURANCE', 'insurance'], documentLabel: 'The policy schedule', documentRequired: false, fields: [text('insurer', 'Insurer'), date('fromDate', 'Cover from', false)], effect: "The property is insured from exchange, as the lender requires." },
  management_pack_requested: { label: 'Management Pack Requested', fields: [text('from', 'Asked of', true, 'The managing agent or landlord'), text('reference', 'Their reference', false)], effect: 'The pack is chased until it arrives.' },
  sdlt_not_required: { label: 'No SDLT Return Due', fields: [text('reason', 'Why no return is due', true)], effect: 'Recorded as your determination; the AP1 can go without an SDLT5.' },
  sdlt_submitted: { label: 'SDLT Return Filed', documentRoles: ['SDLT5', 'SDLT', 'sdlt'], documentLabel: 'SDLT5 certificate', documentRequired: true, fields: [text('reference', 'UTRN', true, '11 characters')], effect: 'The return is filed and the certificate is on file for HM Land Registry.' },
  ap1_submitted: { label: 'AP1 Lodged', documentLabel: 'Application receipt', fields: [text('reference', 'HM Land Registry reference', true)], effect: 'Registration is applied for within the priority period.' },
  ap1_confirmed: { label: 'Registration Confirmed', documentRoles: ['title', 'TITLE', 'OFFICIAL_COPY'], documentLabel: 'Completed registration or updated official copy', documentRequired: true, fields: [text('titleNumber', 'Title number', false)], effect: 'The client is the registered proprietor.' },
  notice_of_assignment_served: { label: 'Notice of Assignment Served', documentRoles: ['NOTICE_OF_ASSIGNMENT', 'notice'], documentLabel: 'The notice as served', fields: [text('servedOn', 'Served on', true), text('reference', 'Reference', false)], effect: 'The landlord or managing agent is told of the new owner.' },
  client_decision_recorded: { label: 'Record Client Decision', documentLabel: 'The email or signed instruction, if there is one', party: { label: 'Which client confirmed, how, and when' }, effect: "The client's own decision, recorded in their words." },
};

export class CompletionError extends Error {
  status = 400;
  constructor(msg: string) {
    super(msg);
    this.name = 'CompletionError';
  }
}

/** Refuse a contracted command that lacks what its contract asks for. Lists everything missing. */
export function assertCompletion(type: string, cmd: Record<string, unknown>): void {
  const c = COMPLETION_CONTRACTS[type as CommandType];
  if (!c) return;
  const completion = (cmd.completion ?? {}) as Completion;
  const missing: string[] = [];
  const docId = (cmd.documentId as string | undefined) ?? completion.documentId ?? null;
  if (c.documentRequired && !docId) missing.push((c.documentLabel ?? 'the document').replace(/^[A-Z]/, (ch) => ch.toLowerCase()));
  for (const f of c.fields ?? []) {
    if (!f.required) continue;
    const v = cmd[f.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) missing.push(f.label.toLowerCase());
  }
  for (const item of c.checklist ?? []) if (!completion.checklist?.[item.key]) missing.push(`confirm: ${item.label.toLowerCase()}`);
  if (c.party && (!completion.party?.who?.trim() || !completion.party?.channel?.trim())) missing.push('who confirmed and how');
  if (missing.length) throw new CompletionError(`${c.label} needs ${missing.join(', ')}.`);
}
