/**
 * What is waiting on us, now: every step a person at the firm has to take on this case, derived from
 * the state (so it can never drop off anyone's list). The engine does what it can itself (requests,
 * emails, drafts); what is left is here, and on the Tasks tab, each with the form that records it.
 * Things owed by the client or a third party are waits (chased, with a Confirm on the tab), not these.
 */
import { stageBlockers } from './machine';
import { profileOf } from './transactions';
import { SHAPE_SPEC } from './shapes';
import { isResolved, type MatterState } from './types';
import { subtractWorkingDays, addWorkingDays, EW_CALENDAR } from './working-days';

export interface DueStep {
  key: string;
  /** The flowchart section it belongs to (the task opens it there too). */
  lane: string;
  title: string;
  detail?: string;
  /** When it must be done by, if there is a date. */
  dueDate?: string | null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export function dueSteps(s: MatterState, now: Date = new Date()): DueStep[] {
  if (!s.enrolled || s.abandoned || s.closedAt) return [];
  const tt = s.transactionType ?? 'freehold_purchase';
  const p = profileOf(tt);
  const buyer = p.side === 'buyer', seller = p.side === 'seller';
  const remo = tt === 'remortgage', toe = tt === 'transfer_of_equity';
  const exchanged = !!s.exchange.exchangedAt, completed = !!s.completion.confirmedAt;
  const paid = (kind: string, purpose?: string) => s.payments.some((x) => x.payeeKind === kind && (!purpose || x.purpose === purpose));
  const fundsFrom = [...p.fundsFrom, ...(s.shapes ?? []).map((sh) => SHAPE_SPEC[sh]?.fundsFrom).filter(Boolean)] as string[];
  const completionDate = s.exchange.completionDate ?? s.targetCompletionDate ?? null;
  const out: DueStep[] = [];
  const add = (x: DueStep) => out.push(x);

  // ── Before exchange ──
  if (!completed && (seller || remo || toe) && s.title.status === 'awaiting')
    add({ key: 'official_copies', lane: 'title', title: 'Get the official copies from HM Land Registry and file them', detail: 'Read as they are filed.' });
  if (seller && p.hasExchange && !s.contractPack.sentAt && s.propertyForms.status === 'received' && s.title.status !== 'awaiting')
    add({ key: 'contract_pack', lane: 'exchange', title: "Send the contract pack to the buyer's solicitor" });
  if (tt === 'leasehold_sale' && s.managementPack.status === 'not_started')
    add({ key: 'management_pack_sale', lane: 'leasehold', title: 'Ask the managing agent for the management pack (LPE1)' });
  if (seller && s.contractPack.sentAt && !s.readiness.contractApprovedAt && !exchanged)
    add({ key: 'contract_approved_sale', lane: 'exchange', title: "Record the buyer's solicitor approving the contract" });
  const unreplied = Object.values(s.inboundEnquiries ?? {}).filter((q) => !q.repliedAt);
  if (seller && unreplied.length && !exchanged)
    add({ key: 'buyer_enquiries', lane: 'enquiries', title: `Reply to the buyer's enquiries (${unreplied.length})` });
  if (buyer && p.hasExchange && s.stage === 'pre_exchange' && s.exchange.conditionsMet && !exchanged)
    add({ key: 'exchange', lane: 'exchange', title: 'Exchange contracts', detail: 'Everything is in place: exchange when the client instructs.' });
  if (seller && p.hasExchange && s.stage === 'pre_exchange' && s.exchange.conditionsMet && !exchanged)
    add({ key: 'exchange', lane: 'exchange', title: 'Exchange contracts', detail: "Everything is in place on our side: exchange with the buyer's solicitor." });

  // ── Exchange to completion ──
  if (exchanged && !s.completion.statementGeneratedAt && !completed)
    add({ key: 'completion_statement', lane: 'exchange', title: 'Check the completion statement and send it to the client', detail: 'Drafted on exchange under Documents.' });
  if (s.hasLender && (buyer || remo) && isResolved(s.mortgage.status) && !s.deeds.certificateOfTitleAt && !completed && (exchanged || remo)) {
    const due = completionDate ? day(subtractWorkingDays(new Date(completionDate), 5, EW_CALENDAR)) : null;
    add({ key: 'certificate_of_title', lane: 'mortgage', title: 'Send the certificate of title to the lender', detail: "Through the lender's portal; it releases the advance.", dueDate: due });
  }
  const lenderChecks = s.hasLender && (buyer || remo) && !completed && (exchanged || (remo && s.stage === 'pre_completion'));
  if (lenderChecks && !s.preCompletion.bankruptcySearchAt) add({ key: 'bankruptcy_search', lane: 'pre_completion_checks', title: 'Bankruptcy search (K16) against every borrower' });
  const os1Expired = !!(s.preCompletion.prioritySearchExpiresAt && Date.parse(s.preCompletion.prioritySearchExpiresAt) < now.getTime());
  if (lenderChecks && (!s.preCompletion.prioritySearchAt || os1Expired)) add({ key: 'priority_search', lane: 'pre_completion_checks', title: os1Expired ? 'Priority search (OS1) has expired: make a new one' : 'Priority search (OS1)' });
  if (s.stage === 'pre_completion' && !s.completion.fundsRequestedAt && !s.completion.fundsReceivedAt && fundsFrom.some((f) => f === 'lender' || f === 'client' || f === 'isa_provider'))
    add({ key: 'funds_request', lane: 'completion', title: 'Request the completion funds', detail: "Needs our client account's bank details verified." });
  if (s.stage === 'pre_completion' && fundsFrom.includes('buyer_solicitor') && !s.completion.fundsReceivedAt)
    add({ key: 'completion_monies', lane: 'completion', title: "Confirm the completion monies are in from the buyer's solicitor", dueDate: completionDate });
  if (s.stage === 'pre_completion' && fundsFrom.includes('incoming_owner') && (s.considerationPennies ?? 0) > 0 && !s.completion.fundsReceivedAt)
    add({ key: 'consideration', lane: 'completion', title: 'Confirm the consideration is in from the incoming owner', dueDate: completionDate });
  if (buyer && s.stage === 'pre_completion' && s.completion.fundsReceivedAt && !paid('seller_solicitor', 'completion_monies'))
    add({ key: 'completion_payment', lane: 'completion', title: "Authorise the completion payment to the seller's solicitor", dueDate: completionDate });
  if ((seller || remo) && s.redemption.status === 'received' && s.stage === 'pre_completion' && !paid('lender'))
    add({ key: 'redemption_payment', lane: 'redemption', title: 'Authorise the redemption payment to the lender', dueDate: completionDate });
  if (s.stage === 'pre_completion' && !completed && s.completion.fundsReceivedAt && (!buyer || paid('seller_solicitor', 'completion_monies')))
    add({ key: 'completion', lane: 'completion', title: 'Confirm completion', dueDate: completionDate });

  // ── After completion ──
  if (seller && completed && !paid('client')) add({ key: 'balance_to_client', lane: 'completion', title: 'Authorise the balance to the client' });
  if (completed && (seller || remo) && s.redemption.status === 'received') add({ key: 'mortgage_redeemed', lane: 'redemption', title: 'Record the mortgage as redeemed' });
  if (completed && p.registration === 'ap1' && (buyer || toe) && !s.postCompletion.sdltSubmittedAt && !s.sdltNotRequiredAt)
    add({ key: 'sdlt', lane: 'registration', title: 'File the SDLT return', dueDate: day(addWorkingDays(new Date(s.completion.confirmedAt!), 10, EW_CALENDAR)), detail: 'Due within 14 days of completion.' });
  const sdltDone = !(buyer || toe) || !!s.postCompletion.sdltSubmittedAt || !!s.sdltNotRequiredAt;
  if (completed && p.registration === 'ap1' && sdltDone && !s.postCompletion.ap1SubmittedAt)
    add({ key: 'ap1', lane: 'registration', title: 'Lodge the AP1 at HM Land Registry', dueDate: s.preCompletion.prioritySearchExpiresAt ?? null, detail: s.preCompletion.prioritySearchExpiresAt ? 'Before the priority period ends.' : undefined });
  if (completed && tt === 'leasehold_purchase' && !(s.postCompletion as { noticeOfAssignmentAt?: string | null }).noticeOfAssignmentAt)
    add({ key: 'notice_of_assignment', lane: 'leasehold', title: 'Serve notice of assignment (and charge) on the landlord' });
  if (s.stage === 'post_completion' && stageBlockers(s).length === 0)
    add({ key: 'close_file', lane: 'registration', title: 'Close the file' });
  return out;
}
