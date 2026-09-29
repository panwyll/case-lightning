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

/** The button a step shows on the Tasks list: its own action (the same words as on the case), which opens its form in place. */
export const STEP_ACTION_LABEL: Record<string, string> = {
  contract_pack: 'Record Sent', management_pack_sale: 'Record Requested', contract_approved_sale: 'Record Approved', contract_approve: 'Approve Contract', buyer_enquiries: 'Record Replies Sent',
  exchange: 'Contracts Exchanged', completion_statement: 'Send To Client', certificate_of_title: 'Record Sent', bankruptcy_search: 'Record Clear',
  priority_search: 'Record Made', funds_request: 'Request Funds', completion_monies: 'Record Received', consideration: 'Record Received',
  completion_payment: 'Authorise', redemption_payment: 'Authorise', completion: 'Confirm Completion', balance_to_client: 'Authorise',
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
  funds: { label: 'Record Received' },
  deposit: { label: 'Record Received' },
  redemption: { label: 'Record Received' },
  lender_consent: { label: 'Record Received' },
  discharge: { label: 'Record Confirmed' },
  registration: { label: 'Record Registered' },
  insurance: { label: 'Record Insurance' },
  client_decision: { label: 'Record Decision' },
};
