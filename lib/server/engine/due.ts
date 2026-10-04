/**
 * What is waiting on us, now: every step a person at the firm has to take on this case, derived from
 * the state (so it can never drop off anyone's list). The engine does what it can itself (requests,
 * emails, drafts); what is left is here, and on the Tasks tab, each with the form that records it.
 * Things owed by the client or a third party are waits (chased, with a Confirm on the tab), not these.
 */
import { deathCase } from './people';
import { chargeableConsideration } from './sdlt-facts';
import { computeSdlt } from './sdlt';
import { k16Stale } from './machine';
import { certificateOfTitleUnmet } from './machine';
import { stageBlockers } from './machine';
import { profileOf } from './transactions';
import { SHAPE_SPEC } from './shapes';
import { isResolved, SIGNED_DOCUMENT_LABEL, type MatterState } from './types';
import { moneyOf, position, pounds, ROLE_LABEL } from './money';
import { allDischarged, anythingCharged } from './charges';
import { subtractWorkingDays, addWorkingDays, workingDaysBetween, EW_CALENDAR } from './working-days';

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

/** Messages the case cannot move without: the step each one is part of. */
const ESSENTIAL_UPDATES = new Set(['deposit_request', 'property_forms_request', 'exchange_authority_request', 'balance_request', 'ownership_basis_request', 'buildings_insurance_request']);
const RESEND_TITLE: Record<string, (d: { searchType?: string; documents?: string[] }) => string> = {
  search_order: (d) => `Order the ${d.searchType ?? ''} search`.replace('  ', ' '),
  id_check_request: () => 'Send the client the ID check',
  proof_of_funds_request: () => 'Send the client the proof-of-funds form',
  proof_of_funds_followup: () => 'Ask the client for proof of funds again',
  signing_pack: (d) => { const docs = ((d as { documents?: string[] }).documents ?? []).map((x) => (SIGNED_DOCUMENT_LABEL as Record<string, string>)[x]?.toLowerCase()).filter(Boolean); return `Send the client the signing pack${docs.length ? ` (${docs.join(', ')})` : ''}`; },
  deposit_request: () => 'Ask the client for the deposit',
  property_forms_request: () => 'Send the client the property forms',
  exchange_authority_request: () => "Ask the client for authority to exchange",
  balance_request: () => 'Ask the client for the balance of the completion money',
  ownership_basis_request: () => 'Ask the clients how they will own the property',
  buildings_insurance_request: () => 'Ask the client for their buildings insurance',
};
const RESEND_LANE: Record<string, string> = { search_order: 'searches', id_check_request: 'id_aml', proof_of_funds_request: 'source_of_funds', proof_of_funds_followup: 'source_of_funds', signing_pack: 'signing', deposit_request: 'exchange', property_forms_request: 'property_forms', exchange_authority_request: 'exchange', balance_request: 'completion', ownership_basis_request: 'co_ownership', buildings_insurance_request: 'pre_completion_checks' };

/** Money owed back and money not yet cleared: on our list even on a file that has stopped, until it is dealt with. */
function moneySteps(s: MatterState): DueStep[] {
  const m = moneyOf(s);
  return [
    ...m.uncleared.map((u) => ({ key: `funds_cleared:${u.id}`, lane: 'completion', title: `Confirm ${u.amountPennies != null ? pounds(u.amountPennies) : 'the money'} from ${ROLE_LABEL[u.fromRole]} has cleared`, detail: 'It cannot be paid out until it has.' })),
    ...m.refunds.filter((r) => !r.paidAt).map((r) => ({ key: `refund:${r.id}`, lane: 'completion', title: `Return ${r.amountPennies != null ? pounds(r.amountPennies) : 'the money held'} to ${ROLE_LABEL[r.toRole]}${r.to ? ` (${r.to})` : ''}`, detail: r.reason })),
  ];
}

export function dueSteps(s: MatterState, now: Date = new Date()): DueStep[] {
  if (!s.enrolled) return [];
  if (s.abandoned || s.closedAt) return moneySteps(s);
  const tt = s.transactionType ?? 'freehold_purchase';
  const p = profileOf(tt);
  const buyer = p.side === 'buyer', seller = p.side === 'seller';
  const remo = tt === 'remortgage', toe = tt === 'transfer_of_equity';
  const exchanged = !!s.exchange.exchangedAt, completed = !!s.completion.confirmedAt;
  const paid = (kind: string, purpose?: string) => s.payments.some((x) => x.payeeKind === kind && (!purpose || x.purpose === purpose));
  const fundsFrom = [...p.fundsFrom, ...(s.shapes ?? []).map((sh) => SHAPE_SPEC[sh]?.fundsFrom).filter(Boolean)] as string[];
  const completionDate = s.exchange.completionDate ?? s.targetCompletionDate ?? null;
  const out: DueStep[] = moneySteps(s);
  const add = (x: DueStep) => out.push(x);
  // Money short of what was asked for: ask the client for the difference (a lender's deduction is theirs to make up too).
  const short = (buyer || remo) && !completed ? position(s).shortfallPennies : 0;
  if (short > 0 && !s.waits.some((w) => w.key === 'funds' && w.subject === 'client' && w.closedAt === null))
    add({ key: `shortfall_request:${short}`, lane: 'completion', title: `Ask the client for the ${pounds(short)} still to come`, dueDate: completionDate });
  // A step is offered only once the machine accepts it (a sale acts on the pack and the management pack once the ID check has cleared).
  const STAGE_ORDER = ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'];
  const atLeast = (st: string) => STAGE_ORDER.indexOf(s.stage) >= STAGE_ORDER.indexOf(st);

  // ── A person said no to sending something the case cannot do without (the ID check, the signing pack, a search order,
  // the deposit request…): refusing the message is not refusing the step. Until it is done another way, it is a task. ──
  for (const pr of Object.values(s.proposals)) {
    if (pr.status !== 'rejected' || !pr.resolvedBy || pr.resolvedBy === 'system' || completed) continue;
    const d = pr.detail as { kind?: string; template?: string; searchType?: string; documents?: string[] };
    const what = pr.action === 'search_order' ? 'search_order' : d.kind ?? d.template ?? '';
    const still =
      what === 'search_order' ? !!d.searchType && !s.searches[d.searchType as keyof typeof s.searches]
      : what === 'id_check_request' ? s.idCheck.status === 'not_started'
      : what === 'proof_of_funds_request' ? s.proofOfFunds.status === 'not_started'
      : what === 'signing_pack' ? (d.documents ?? []).some((x) => !s.signing.documents.includes(x as never))
      : ESSENTIAL_UPDATES.has(what) ? !s.clientUpdateLastSentAt[what] || s.clientUpdateLastSentAt[what] < (pr.resolvedAt ?? '')
      : false;
    if (!still) continue;
    // Asked again since (pending or approved): that one is the task.
    if (Object.values(s.proposals).some((q) => q.eventId !== pr.eventId && q.status !== 'rejected' && q.proposedAt > pr.proposedAt && q.action === pr.action && JSON.stringify(q.detail.kind ?? q.detail.template ?? q.detail.searchType) === JSON.stringify(d.kind ?? d.template ?? d.searchType))) continue;
    // A newer signing pack waiting to go: one pack at a time on the list (what this one held comes back once that goes, if still unsent).
    if (what === 'signing_pack' && Object.values(s.proposals).some((q) => q.status === 'pending' && (q.detail as { kind?: string }).kind === 'signing_pack')) continue;
    add({ key: `resend:${pr.eventId}`, lane: RESEND_LANE[what] ?? 'case', title: RESEND_TITLE[what] ? RESEND_TITLE[what](d) : 'Send what was held back' });
  }

  // ── Before exchange ──
  // A report a person sent back is written again (their note says what to change); the case cannot move until it goes.
  if (buyer && s.reportOnTitle.status === 'rejected' && !exchanged)
    add({ key: 'report_on_title_redraft', lane: 'report_on_title', title: 'Draft the report on title again' });
  // Approved and not gone (the send failed, or it was approved where nothing sends on its own): a person sends it.
  if (buyer && s.reportOnTitle.status === 'approved' && !exchanged)
    add({ key: 'report_on_title_send', lane: 'report_on_title', title: 'Send the approved report on title to the client' });
  // Our sole client died before exchange on a purchase: the case closes (the notices are drafted on their own tasks).
  const died = (s.partyEvents ?? []).find((p) => p.event === 'died' && deathCase(s, p.party, buyer ? 'buyer' : seller ? 'seller' : 'owner') === 'close');
  if (died && !s.abandoned && !completed) add({ key: 'death_close', lane: 'id_aml', title: `Close the case: ${died.party} has died` });
  // The firm's policy wants proof of funds and the form never went (the start-of-case send was not made or not approved): send it.
  // Something is already in hand when a proposal for it is waiting, or a person held one back (its own task, below, sends it).
  const everProposed = (kind: string) => Object.values(s.proposals).some((q) => ((q.detail as { kind?: string }).kind === kind || (q.detail as { template?: string }).template === kind) && (q.status === 'pending' || (q.status === 'rejected' && !!q.resolvedBy && q.resolvedBy !== 'system')));
  if (buyer && s.requireProofOfFunds && s.proofOfFunds.status === 'not_started' && !exchanged && !completed && !everProposed('proof_of_funds_request'))
    add({ key: 'proof_of_funds_request', lane: 'proof_of_funds', title: 'Send the client the proof-of-funds form' });
  // Signed off, then something new about the money (a gift or loan mentioned later): the sign-off no longer covers it (money.md 1.1).
  const fundsQuestion = Object.values(s.issues).find((i) => i.kind === 'source_of_funds' && (i.status === 'open' || i.status === 'negotiating') && !/^Money still to arrive/.test(i.title));
  if (buyer && s.proofOfFunds.status === 'reviewed' && s.proofOfFunds.resolution === 'approve' && fundsQuestion && !exchanged && !completed && !everProposed('proof_of_funds_request'))
    add({ key: 'proof_of_funds_followup', lane: 'proof_of_funds', title: `Ask the client for proof of funds again: ${fundsQuestion.title.slice(0, 80)}` });
  if (!completed && (seller || remo || toe) && s.title.status === 'awaiting')
    add({ key: 'official_copies', lane: 'title', title: 'Get the official copies from HM Land Registry and file them' });
  if (seller && p.hasExchange && atLeast('pre_contract') && !s.contractPack.sentAt && s.propertyForms.status === 'received' && s.title.status !== 'awaiting')
    add({ key: 'contract_pack', lane: 'exchange', title: "Send the contract pack to the buyer's solicitor" });
  if (tt === 'leasehold_sale' && atLeast('pre_contract') && s.managementPack.status === 'not_started')
    add({ key: 'management_pack_sale', lane: 'leasehold', title: 'Ask the managing agent for the management pack (LPE1)' });
  if (seller && s.contractPack.sentAt && atLeast('contract_review') && !s.readiness.contractApprovedAt && !exchanged)
    add({ key: 'contract_approved_sale', lane: 'exchange', title: "Record the buyer's solicitor approving the contract" });
  // A purchase's contract on file but no approval task on the list (it arrived before contract review, or the case was moved on by hand): approve it here.
  if (buyer && p.hasExchange && s.readiness.contractDocumentId && !s.readiness.contractApprovedAt && !exchanged && ['contract_review', 'pre_exchange'].includes(s.stage) && !Object.values(s.decisions).some((d) => d.kind === 'contract' && d.status === 'pending'))
    add({ key: 'contract_approve', lane: 'exchange', title: 'Approve the contract for signature' });
  const unreplied = Object.values(s.inboundEnquiries ?? {}).filter((q) => !q.repliedAt);
  if (seller && unreplied.length && !exchanged)
    add({ key: 'buyer_enquiries', lane: 'enquiries', title: `Reply to the buyer's enquiries (${unreplied.length})` });
  if (buyer && p.hasExchange && s.stage === 'pre_exchange' && s.exchange.conditionsMet && !exchanged)
    add({ key: 'exchange', lane: 'exchange', title: 'Exchange contracts' });
  if (seller && p.hasExchange && s.stage === 'pre_exchange' && s.exchange.conditionsMet && !exchanged)
    add({ key: 'exchange', lane: 'exchange', title: 'Exchange contracts' });

  // ── Exchange to completion ──
  if ((exchanged || ((remo || toe) && s.stage === 'pre_completion')) && !s.completion.statementGeneratedAt && !completed)
    add({ key: 'completion_statement', lane: 'exchange', title: 'Check the completion statement and send it to the client' });
  // The certificate of title, only once it can be given unqualified (the checks below done, the client's money in), due the lender's notice before completion.
  if (s.hasLender && (buyer || remo) && isResolved(s.mortgage.status) && !s.deeds.certificateOfTitleAt && !completed && (exchanged || remo) && certificateOfTitleUnmet(s, now).length === 0) {
    const due = completionDate ? day(subtractWorkingDays(new Date(completionDate), 5, EW_CALENDAR)) : null;
    add({ key: 'certificate_of_title', lane: 'pre_completion_checks', title: 'Send the certificate of title to the lender', dueDate: due });
  }
  const lenderChecks = s.hasLender && (buyer || remo) && !completed && (exchanged || (remo && s.stage === 'pre_completion'));
  if (lenderChecks && (!s.preCompletion.bankruptcySearchAt || (!s.deeds.certificateOfTitleAt && k16Stale(s, now)))) add({ key: 'bankruptcy_search', lane: 'pre_completion_checks', title: s.preCompletion.bankruptcySearchAt ? 'A fresh bankruptcy search (K16): the last is too old or misses a borrower' : 'Bankruptcy search (K16) against every borrower' });
  const os1Expired = !!(s.preCompletion.prioritySearchExpiresAt && Date.parse(s.preCompletion.prioritySearchExpiresAt) < now.getTime());
  // Every purchase needs a priority search (a cash buyer's registration is protected the same way); a remortgage, for its lender.
  const os1Due = !completed && ((buyer && exchanged) || (remo && s.hasLender && s.stage === 'pre_completion'));
  if (os1Due && (!s.preCompletion.prioritySearchAt || os1Expired)) add({ key: 'priority_search', lane: 'pre_completion_checks', title: os1Expired ? 'Priority search (OS1) has expired: make a new one' : 'Priority search (OS1)' });
  // The client's money is asked for once the completion statement is out; the lender's advance only against the certificate of title.
  const asked = (role: string) => s.waits.some((w) => w.key === 'funds' && w.subject === role);
  const received = (role: string) => (s.completion.receivedFrom ?? []).includes(role as never);
  const clientRoles = fundsFrom.filter((f) => f === 'client' || f === 'isa_provider');
  if (s.stage === 'pre_completion' && clientRoles.some((r) => !asked(r) && !received(r)))
    add({ key: 'funds_request', lane: 'completion', title: "Request the client's completion money", detail: "Needs our client account's bank details verified." });
  if (s.stage === 'pre_completion' && s.hasLender && fundsFrom.includes('lender') && s.deeds.certificateOfTitleAt && !asked('lender') && !received('lender'))
    add({ key: 'advance_request', lane: 'completion', title: 'Request the mortgage advance from the lender', dueDate: completionDate ? day(subtractWorkingDays(new Date(completionDate), 3, EW_CALENDAR)) : null });
  if (s.stage === 'pre_completion' && fundsFrom.includes('buyer_solicitor') && !s.completion.fundsReceivedAt)
    add({ key: 'completion_monies', lane: 'completion', title: "Confirm the completion monies are in from the buyer's solicitor", dueDate: completionDate });
  if (s.stage === 'pre_completion' && fundsFrom.includes('incoming_owner') && (s.considerationPennies ?? 0) > 0 && !s.completion.fundsReceivedAt)
    add({ key: 'consideration', lane: 'completion', title: 'Confirm the consideration is in from the incoming owner', dueDate: completionDate });
  if (buyer && s.stage === 'pre_completion' && s.completion.fundsReceivedAt && !short && !moneyOf(s).uncleared.length && !paid('seller_solicitor', 'completion_monies'))
    add({ key: 'completion_payment', lane: 'completion', title: "Authorise the completion payment to the seller's solicitor", dueDate: completionDate });
  if (buyer && s.stage === 'pre_completion' && paid('seller_solicitor', 'completion_monies') && !s.completion.paymentSent)
    add({ key: 'completion_payment_sent', lane: 'completion', title: "Send the completion money and record the CHAPS reference", dueDate: completionDate });
  if ((seller || remo) && s.redemption.status === 'received' && s.stage === 'pre_completion' && !paid('lender'))
    add({ key: 'redemption_payment', lane: 'redemption', title: 'Authorise the redemption payment to the lender', dueDate: completionDate });
  // Confirm completion only when that is the one thing left (the signed TR1 in, the money in and paid): offered before, it is refused.
  // No money moves on some transfers (a court order, a gift of a share): then completion needs no funds in.
  const fundsExpected = fundsFrom.some((f) => (f === 'lender' && s.hasLender) || f === 'client' || f === 'buyer_solicitor' || f === 'isa_provider' || (f === 'incoming_owner' && (s.considerationPennies ?? 0) > 0));
  if (s.stage === 'pre_completion' && !completed && (s.completion.fundsReceivedAt || !fundsExpected) && (!buyer || (paid('seller_solicitor', 'completion_monies') && !!s.completion.paymentSent)) && stageBlockers(s).every((b) => b === 'completion not confirmed'))
    add({ key: 'completion', lane: 'completion', title: 'Confirm completion', dueDate: completionDate });

  // The tax answers the basis is worked out from (sdlt-facts.ts): the buyers' before exchange, the seller's two CGT questions.
  if ((buyer || toe) && !s.sdltFacts && !exchanged && !completed) add({ key: 'sdlt_facts', lane: 'exchange', title: "Record the buyers' SDLT answers" });
  if (seller && !s.cgtFacts && !exchanged) add({ key: 'cgt_facts', lane: 'exchange', title: "Record the client's CGT answers (main home throughout? UK resident?)" });
  // A new build's contract carries a long-stop date: on the case, so its clock is watched (dates.ts).
  if (buyer && s.shapes?.includes('new_build') && !s.longStopDate && !completed && ['contract_review', 'pre_exchange', 'exchanged', 'pre_completion'].includes(s.stage)) add({ key: 'longstop_date', lane: 'exchange', title: 'Record the long-stop date from the new-build contract' });
  // Tenants in common in unequal shares: the declaration of trust needs the figures (co-owners.ts).
  if ((buyer || toe) && s.parties > 1 && s.clientDecisions.ownership_basis?.decision === 'tenants_in_common_unequal' && !s.coOwnership && !s.deeds.deedOfTrustAt && !completed) add({ key: 'contributions', lane: 'co_ownership', title: 'Record what each buyer puts in, and how the declaration of trust shares it' });

  // The final bill, before anything is taken from client money for fees and before the file closes (SRA Accounts Rules 4.3).
  if (completed && !s.finalBill) add({ key: 'final_bill', lane: 'registration', title: 'Send the client the final bill' });

  // ── After registration (theme H): the new register read; a requisition that cannot be met in time ──
  if (s.postCompletion.ap1ConfirmedAt && !s.registerCheckedAt && p.registration === 'ap1') add({ key: 'register_check', lane: 'registration', title: 'Check the new register: proprietors, the charges, any restriction' });
  for (const r of s.postCompletion.requisitions.filter((x) => !x.respondedAt && x.deadline)) {
    if (workingDaysBetween(now, new Date(r.deadline!), EW_CALENDAR) <= 5) add({ key: `requisition_extend:${r.eventId}`, lane: 'registration', title: `Answer the requisition by ${r.deadline!.slice(0, 10)}, or ask HM Land Registry for more time`, dueDate: r.deadline!.slice(0, 10) });
  }

  // A sale: the buyer's deposit is ours to receive on exchange (unless it went up the chain) (exchange.md 5.4).
  if (seller && exchanged && !completed && !s.deposit.received && s.exchange.depositRoute !== 'up_the_chain') add({ key: 'deposit_in', lane: 'exchange', title: "Confirm the buyer's deposit has arrived", dueDate: s.exchange.exchangedAt ? day(addWorkingDays(new Date(s.exchange.exchangedAt), 1, EW_CALENDAR)) : null });

  // ── Charges and undertakings (charges.ts) ──
  if ((seller || remo) && !exchanged && !completed) for (const c of (s.otherCharges ?? []).filter((x) => x.status === 'to_redeem')) add({ key: `charge_statement:${c.id}`, lane: 'redemption', title: `Get a redemption figure from ${c.chargee}` });
  if (seller && exchanged && !completed && anythingCharged(s) && !s.undertaking) add({ key: 'undertaking', lane: 'redemption', title: "Give the buyer's solicitor our undertaking to redeem (reply to their completion information)", dueDate: completionDate });
  if (buyer && exchanged && !completed && !s.completionInformation) add({ key: 'completion_information', lane: 'completion', title: "Record the seller's replies to completion information (TA13)", dueDate: completionDate });
  if (completed) for (const c of (s.otherCharges ?? []).filter((x) => x.status === 'received')) add({ key: `charge_redeemed:${c.id}`, lane: 'redemption', title: `Pay off ${c.chargee} and record it` });
  if (completed && s.undertaking && !s.undertaking.dischargedAt && allDischarged(s)) add({ key: 'undertaking_discharge', lane: 'registration', title: "Send the discharges to the buyer's solicitor: our undertaking is then done" });

  // ── After completion ──
  if (seller && completed && !paid('client')) add({ key: 'balance_to_client', lane: 'completion', title: 'Authorise the balance to the client' });
  // The agent's invoice came in with its bank details: their commission is paid from the proceeds, against the client's authority (completion.md 4.12).
  if (seller && completed && Object.values(s.bankDetails).some((b) => b.payeeKind === 'estate_agent') && !paid('estate_agent')) add({ key: 'agent_commission', lane: 'completion', title: "Pay the estate agent's commission (check the invoice against the agreed fee)" });
  if (completed && (seller || remo) && s.redemption.status === 'received') add({ key: 'mortgage_redeemed', lane: 'redemption', title: 'Record the mortgage as redeemed' });
  if (completed && p.registration === 'ap1' && (buyer || toe) && !s.postCompletion.sdltSubmittedAt && !s.sdltNotRequiredAt)
    add({ key: 'sdlt', lane: 'registration', title: s.sdltBasis?.wales ? 'File the LTT return (Welsh Revenue Authority)' : 'File the SDLT return', dueDate: day(new Date(Date.parse(s.completion.confirmedAt!) + (s.sdltBasis?.wales ? 30 : 14) * 86_400_000)) });
  // The tax goes with the return (completion.md 6.3): paid to HMRC's account, verified like any other.
  if (completed && (buyer || toe) && s.postCompletion.sdltSubmittedAt && !s.sdltBasis?.wales && !paid('hmrc') && (() => { const c = chargeableConsideration(s); return !!c && computeSdlt(c, { ...(s.sdltBasis ?? { firstTimeBuyer: false, additionalProperty: false, nonUkResident: false }), company: s.shapes?.includes('company_buyer') ?? false }).totalPennies > 0; })())
    add({ key: 'sdlt_payment', lane: 'registration', title: 'Pay the Stamp Duty to HMRC' });
  const sdltDone = !(buyer || toe) || !!s.postCompletion.sdltSubmittedAt || !!s.sdltNotRequiredAt;
  if (completed && p.registration === 'ap1' && sdltDone && !s.postCompletion.ap1SubmittedAt)
    add({ key: 'ap1', lane: 'registration', title: 'Lodge the AP1 at HM Land Registry', dueDate: s.preCompletion.prioritySearchExpiresAt ?? null });
  if (completed && tt === 'leasehold_purchase' && !(s.postCompletion as { noticeOfAssignmentAt?: string | null }).noticeOfAssignmentAt)
    add({ key: 'notice_of_assignment', lane: 'leasehold', title: 'Serve notice of assignment (and charge) on the landlord' });
  if (s.stage === 'post_completion' && stageBlockers(s).every((b) => b === 'matter complete'))
    add({ key: 'close_file', lane: 'registration', title: 'Close the file' });
  return out;
}
