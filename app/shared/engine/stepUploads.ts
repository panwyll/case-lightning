import { uploadCaseFile } from './uploadCaseFile';
import type { Api } from './types';

/** What an uploaded file was read as, in words. */
const READ_AS: Record<string, string> = {
  title: 'the register', title_plan: 'the title plan', search: 'a search result', enquiry_reply: 'replies to enquiries', mortgage_offer: 'a mortgage offer',
  supporting_document: 'a supporting document', id_check: 'an ID check result', contract: 'a contract', survey: 'a survey', specialist_report: "a specialist's report",
  management_pack: 'a management pack', lease: 'a lease', property_forms: "the seller's property forms", other: 'something else',
};

/**
 * Steps done by filing a document the firm got by hand (official copies from HM Land Registry):
 * the button's label, and what the file must be read as for the step to be done.
 */
export const STEP_UPLOADS: Record<string, { label: string; wants: string[]; what: string }> = {
  official_copies: { label: 'Upload Official Copies', wants: ['title', 'title_plan'], what: 'official copies' },
};

export interface UploadOutcome { ok: boolean; text: string }

/**
 * Upload the files for a step and say plainly what happened: read as what the step needs (done),
 * or filed but read as something else (the step stays, and why). Throws with the reason if an upload fails.
 */
export async function uploadForStep(api: Api, matterId: string, stepKey: string, files: File[], progress?: (done: number) => void): Promise<UploadOutcome> {
  return uploadFor(api, matterId, STEP_UPLOADS[stepKey], files, progress);
}

/** Upload files towards something the case is waiting for (or a step), and say what each was read as. */
export async function uploadFor(api: Api, matterId: string, spec: { wants: string[]; what: string; routing?: Record<string, unknown> } | undefined, files: File[], progress?: (done: number) => void): Promise<UploadOutcome> {
  const lines: string[] = [];
  let ok = false;
  for (const [n, file] of files.entries()) {
    const r = await uploadCaseFile<{ action?: { kind: string; reason?: string }; classification?: { role?: string } | null }>(api, matterId, file, spec?.routing ?? { role: 'auto' });
    progress?.(n + 1);
    const kind = r.action?.kind ?? 'skip';
    if (spec?.wants.includes(kind)) { ok = true; lines.push(`${file.name}: read as ${READ_AS[kind] ?? kind}.`); continue; }
    const looks = kind !== 'skip' ? READ_AS[kind] : r.classification?.role ? READ_AS[r.classification.role] : null;
    lines.push(`${file.name}: filed on the case, but it reads as ${looks ?? 'nothing we recognise'}${spec ? `, not ${spec.what}` : ''}.`);
  }
  return { ok, text: lines.join(' ') };
}

/** The button a step shows on the Tasks list: its own action (the same words as on the case), which opens its form in place. A key with an id after a colon (refund:RF-1) takes its kind's label. */
export const stepActionLabel = (key: string): string | undefined => STEP_ACTION_LABEL[key] ?? STEP_ACTION_LABEL[key.split(':')[0]];
export const STEP_ACTION_LABEL: Record<string, string> = {
  contract_pack: 'Record Sent', management_pack_sale: 'Record Requested', contract_approved_sale: 'Record Approved', contract_approve: 'Approve Contract', proof_of_funds_request: 'Send The Form', proof_of_funds_followup: 'Send The Form', report_on_title_redraft: 'Draft Again', buyer_enquiries: 'Record Replies Sent',
  exchange: 'Contracts Exchanged', completion_statement: 'Send To Client', certificate_of_title: 'Record Sent', bankruptcy_search: 'Record Clear',
  priority_search: 'Record Made', funds_request: 'Request Funds', advance_request: 'Request The Advance', completion_monies: 'Record Received', consideration: 'Record Received',
  completion_payment: 'Authorise', redemption_payment: 'Authorise', completion: 'Confirm Completion', balance_to_client: 'Authorise', death_close: 'Close The Case', agent_commission: 'Authorise', sdlt_payment: 'Authorise',
  refund: 'Record Sent', shortfall_request: 'Ask The Client', funds_cleared: 'Record Cleared',
  deposit_in: 'Record Received', final_bill: 'Record Sent', completion_payment_sent: 'Record Sent', contributions: 'Record Contributions', register_check: 'Record Checked', requisition_extend: 'Record More Time', sdlt_facts: 'Record Answers', cgt_facts: 'Record Answers', longstop_date: 'Record Date', charge_statement: 'Record Figure', charge_redeemed: 'Record Paid Off', undertaking: 'Give Undertaking', completion_information: 'Record Replies', undertaking_discharge: 'Record Sent',
  mortgage_redeemed: 'Record Redeemed', sdlt: 'Record Filed', ap1: 'Record Lodged', notice_of_assignment: 'Record Served', close_file: 'Close File',
};

/**
 * What the case is waiting for, done from the Tasks list when it arrives some other way (by post,
 * by hand, in someone's own inbox): the document is uploaded (read, and the wait closes), or the
 * thing is recorded (its form opens in place). `subject` is the wait's subject (a search type, an enquiry id).
 */
export type WaitAction = { label: string; upload?: { wants: string[]; what: string; routing?: (subject: string) => Record<string, unknown> } };
export const WAIT_ACTIONS: Record<string, WaitAction> = {
  contract_pack: { label: 'Upload The Pack', upload: { wants: ['contract', 'title', 'title_plan', 'property_forms'], what: 'the contract pack' } },
  search: { label: 'Upload The Result', upload: { wants: ['search'], what: 'the search result', routing: (subject) => ({ role: 'search', searchType: subject }) } },
  enquiry: { label: 'Upload The Replies', upload: { wants: ['enquiry_reply'], what: 'the replies', routing: (subject) => ({ role: 'enquiry_reply', enquiryId: subject }) } },
  mortgage_offer: { label: 'Upload The Offer', upload: { wants: ['mortgage_offer'], what: 'the mortgage offer', routing: () => ({ role: 'mortgage_offer' }) } },
  survey: { label: 'Upload The Survey', upload: { wants: ['survey'], what: 'the survey', routing: () => ({ role: 'survey' }) } },
  management_pack: { label: 'Upload The Pack', upload: { wants: ['management_pack'], what: 'the management pack', routing: () => ({ role: 'management_pack' }) } },
  property_forms: { label: 'Upload The Forms', upload: { wants: ['property_forms'], what: "the property forms", routing: () => ({ role: 'property_forms' }) } },
  id_check: { label: 'Upload The Result', upload: { wants: ['id_check'], what: 'the ID check result', routing: () => ({ role: 'id_check' }) } },
  signed_documents: { label: 'Record Signed Copy' },
  transfer_deed: { label: 'Record Signed TR1' },
  funds: { label: 'Record Received' },
  deposit: { label: 'Record Received' },
  redemption: { label: 'Record Received' },
  lender_consent: { label: 'Record Received' },
  discharge: { label: 'Record Confirmed' },
  seller_discharge: { label: 'Record Received' },
  retention_release: { label: 'Record Released' },
  registration: { label: 'Record Registered' },
  insurance: { label: 'Record Insurance' },
  client_decision: { label: 'Record Decision' },
};

/** Steps with nothing to fill in: done straight from the row (no form to open). The command each one sends. */
export function directStep(key: string): { label: string; busy: string; done: string; body: Record<string, unknown> } | null {
  if (key.startsWith('resend:')) return { label: 'Send It', busy: 'Sending…', done: 'Sent', body: { type: 'retry_action', proposalEventId: key.slice('resend:'.length) } };
  if (key === 'death_close') return { label: 'Close The Case', busy: 'Closing…', done: 'Closed', body: { type: 'abandon_matter', reason: 'client_died', detail: 'Our client has died' } };
  if (key === 'proof_of_funds_request' || key === 'proof_of_funds_followup') return { label: 'Send The Form', busy: 'Sending…', done: 'Sent', body: { type: 'request_proof_of_funds' } };
  if (key === 'report_on_title_redraft') return { label: 'Draft Again', busy: 'Drafting…', done: 'Drafted', body: { type: 'draft_report_on_title' } };
  if (key.startsWith('funds_cleared:')) return { label: 'Record Cleared', busy: 'Recording…', done: 'Cleared', body: { type: 'funds_cleared', receiptId: key.slice('funds_cleared:'.length) } };
  if (key === 'undertaking_discharge') return { label: 'Record Sent', busy: 'Recording…', done: 'Recorded', body: { type: 'undertaking_discharged' } };
  if (key === 'ap1') return { label: 'Record Lodged', busy: 'Recording…', done: 'Recorded', body: { type: 'ap1_submitted' } };
  return null;
}
