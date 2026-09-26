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

export type FieldKind = 'money' | 'date' | 'datetime' | 'text' | 'names';
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
const names = (key: string, label: string): Field => ({ key, label, kind: 'names', required: true, hint: 'Comma-separated' });

export const COMPLETION_CONTRACTS: Partial<Record<CommandType, CompletionContract>> = {
  contract_pack_sent: { label: 'Contract Pack Sent', documentRoles: ['contract', 'CONTRACT', 'CONTRACT_PACK'], documentLabel: 'The draft contract sent', documentRequired: true, effect: "Records the pack as out; the buyer's enquiries can now arrive." },
  contract_approved: { label: 'Contract Approved', documentRoles: ['contract', 'CONTRACT'], documentLabel: 'The approved contract', documentRequired: true, fields: [text('note', 'Approved subject to', false)], effect: 'Marks the contract as approved for signature.' },
  signed_contract_held: { label: 'Signed Contract Held', documentRoles: ['contract', 'CONTRACT', 'SIGNED_CONTRACT'], documentLabel: 'The signed contract', documentRequired: true, checklist: [{ key: 'every_signatory', label: 'Every client has signed' }, { key: 'dated', label: 'Left undated for exchange' }], effect: 'The signed part is on file, ready to exchange.' },
  deposit_received: { label: 'Deposit Received', documentLabel: 'Remittance or client-account receipt', fields: [money('amountPennies', 'Amount received')], effect: 'Records the deposit as held on client account.' },
  contracts_exchanged: { label: 'Contracts Exchanged', fields: [date('completionDate', 'Completion date agreed'), { key: 'exchangedAt', label: 'Exchanged at', kind: 'datetime', required: false }], checklist: [{ key: 'formula', label: 'Exchanged under a Law Society formula' }, { key: 'deposit_held', label: 'Deposit held or sent as agreed' }], effect: 'The contract is binding from this moment. Completion date and deposit become contractual.' },
  completion_statement_generated: { label: 'Completion Statement Produced', documentRoles: ['COMPLETION_STATEMENT', 'completion_statement'], documentLabel: 'The completion statement', documentRequired: true, effect: 'The statement is on file; funds can be requested against it.' },
  funds_received: { label: 'Funds Received', documentLabel: 'Bank receipt', fields: [money('amountPennies', 'Amount received')], effect: 'Records the money as received on client account.' },
  completion_confirmed: { label: 'Completion Confirmed', fields: [{ key: 'completedAt', label: 'Completed at', kind: 'datetime', required: false }], checklist: [{ key: 'monies_sent', label: "Completion monies sent and receipt confirmed by the other side" }, { key: 'keys', label: 'Keys released / vacant possession confirmed' }], effect: 'The transaction has completed. The registration clock starts.' },
  mortgage_deed_executed: { label: 'Mortgage Deed Executed', documentRoles: ['MORTGAGE_DEED', 'mortgage_deed', 'DEED'], documentLabel: 'The executed mortgage deed', documentRequired: true, checklist: [{ key: 'every_borrower', label: 'Every borrower has signed' }, { key: 'witnessed', label: 'Signatures witnessed' }], effect: 'The deed is held for completion.' },
  certificate_of_title_sent: { label: 'Certificate of Title Sent', documentRoles: ['CERTIFICATE_OF_TITLE', 'certificate_of_title'], documentLabel: 'The certificate sent to the lender', fields: [date('completionDate', 'Completion date on the certificate')], effect: 'The lender is asked to release the advance for the completion date.' },
  transfer_deed_executed: { label: 'Transfer Deed Executed', documentRoles: ['TR1', 'TRANSFER_DEED', 'transfer_deed', 'DEED'], documentLabel: 'The executed TR1', documentRequired: true, fields: [names('parties', 'Who signed')], checklist: [{ key: 'witnessed', label: 'Signatures witnessed' }], effect: 'The transfer is executed and held for completion.' },
  deed_of_trust_executed: { label: 'Declaration of Trust Executed', documentRoles: ['DEED_OF_TRUST', 'deed_of_trust', 'DEED'], documentLabel: 'The executed declaration', documentRequired: true, fields: [names('parties', 'Who signed'), text('shares', 'Shares', false, 'e.g. 60/40')], effect: "Records how the clients hold the property between themselves." },
  property_forms_received: { label: 'Property Forms Received', documentRoles: ['TA6', 'TA10', 'TA7', 'PROPERTY_FORMS', 'property_forms'], documentLabel: 'The completed forms', documentRequired: true, checklist: [{ key: 'TA6', label: 'TA6 property information' }, { key: 'TA10', label: 'TA10 fittings and contents' }], effect: 'The forms go into the contract pack.' },
  enquiry_replies_sent: { label: 'Replies Sent', documentRoles: ['ENQUIRY_REPLIES', 'enquiry_replies'], documentLabel: 'The replies as sent', effect: "The buyer's enquiries are answered; the wait on our side closes." },
  redemption_statement_received: { label: 'Redemption Statement Received', documentRoles: ['REDEMPTION_STATEMENT', 'redemption_statement'], documentLabel: 'The statement', documentRequired: true, fields: [money('redemptionPennies', 'Redemption figure'), date('validUntil', 'Valid until', false), money('dailyInterestPennies', 'Daily interest', false)], effect: 'The figure the completion statement is built on.' },
  mortgage_redeemed: { label: 'Mortgage Redeemed', documentLabel: "Lender's confirmation", fields: [money('amountPennies', 'Amount paid')], effect: 'The existing charge is paid off; the discharge is awaited.' },
  discharge_confirmed: { label: 'Discharge Confirmed', documentRoles: ['DS1', 'EDS1', 'DISCHARGE', 'discharge'], documentLabel: 'DS1 or e-DS1', documentRequired: true, fields: [text('reference', "Lender's reference", false)], effect: 'The charge is off the title.' },
  lender_consent_received: { label: 'Lender Consent Received', documentRoles: ['LENDER_CONSENT', 'lender_consent'], documentLabel: "The lender's consent letter", documentRequired: true, fields: [text('conditions', 'Conditions of consent', false)], effect: 'The lender agrees to the transfer.' },
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
