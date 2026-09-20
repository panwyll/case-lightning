/**
 * The case model (docs/case-model.md): a coarse case lifecycle orchestrating concurrent
 * workstreams, connected by requirements and gates, with issues modifying a dependency
 * graph. Everything here is a PURE PROJECTION of MatterState — the engine's stages,
 * sub-flows, decisions, waits, issues and client decisions — so the two read-only views
 * (readiness, dependencies) can never drift from what the machine actually enforces.
 *
 * It answers the three questions at any moment:
 *   1. Where are we?                      → lifecycle(), workstreams()
 *   2. What is preventing us progressing? → gate('exchange').unsatisfied, with blockedBy traced
 *   3. What needs to happen next, and who has authority to say it has happened? → nextActions()
 */
import { ISSUE_KIND_SPEC, WORKSTREAMS, type IssueSeverity, type Workstream } from './issues';
import { stageBlockers } from './machine';
import { DEFAULT_SLA } from './sla';
import { deedOfTrustApplies, isLeasehold, isResolved, openIssues, openPofQueries, openWaits, pendingDecisions, proofOfFundsApproved, surveyApplies, type DecisionState, type IssueState, type MatterState, type WaitState } from './types';
import { profileOf, type TransactionProfile } from './transactions';

// ───────────────────────────── 1 · the coarse lifecycle ─────────────────────────────

export const LIFECYCLE = ['instructed', 'pre_exchange', 'ready_to_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion', 'closed'] as const;
/** Types without an exchange (remortgage, transfer of equity) read investigating → ready to complete instead of the exchange states. */
export const LIFECYCLE_NO_EXCHANGE = ['instructed', 'investigating', 'ready_to_complete', 'completed', 'post_completion', 'closed'] as const;
export type Lifecycle = (typeof LIFECYCLE)[number] | (typeof LIFECYCLE_NO_EXCHANGE)[number] | 'aborted';
export const LIFECYCLE_LABEL: Record<Lifecycle, string> = { instructed: 'Instructed', pre_exchange: 'Pre-exchange', ready_to_exchange: 'Ready to exchange', exchanged: 'Exchanged', pre_completion: 'Pre-completion', investigating: 'Investigating', ready_to_complete: 'Ready to complete', completed: 'Completed', post_completion: 'Post-completion', closed: 'Closed', aborted: 'Aborted' };
export const lifecycleFor = (p: TransactionProfile): readonly Lifecycle[] => (p.hasExchange ? LIFECYCLE : LIFECYCLE_NO_EXCHANGE);

/** The engine's finer stages are phases inside PRE-EXCHANGE; READY TO EXCHANGE / READY TO COMPLETE are derived gate states, not steps. */
export function lifecycle(s: MatterState): Lifecycle {
  if (s.abandoned) return 'aborted';
  if (s.closedAt) return 'closed';
  const p = profileOf(s.transactionType);
  if (!p.hasExchange) {
    switch (s.stage) {
      case 'instruction':
        return 'instructed';
      case 'pre_contract':
      case 'contract_review':
      case 'pre_exchange':
      case 'exchanged':
        return 'investigating';
      case 'pre_completion':
        return gate(s, 'completion').ready ? 'ready_to_complete' : 'investigating';
      case 'completed':
        return 'completed';
      case 'post_completion':
        return 'post_completion';
    }
  }
  switch (s.stage) {
    case 'instruction':
      return 'instructed';
    case 'pre_contract':
    case 'contract_review':
      return 'pre_exchange';
    case 'pre_exchange':
      return gate(s, 'exchange').ready ? 'ready_to_exchange' : 'pre_exchange';
    case 'exchanged':
      return 'exchanged';
    case 'pre_completion':
      return 'pre_completion';
    case 'completed':
      return 'completed';
    case 'post_completion':
      return 'post_completion';
  }
}

// ───────────────────────────── 2 · concurrent workstreams ─────────────────────────────

export type WorkstreamStatus = 'not_applicable' | 'not_started' | 'in_progress' | 'awaiting' | 'under_review' | 'blocked' | 'at_risk' | 'complete';
export interface WorkstreamView {
  id: Workstream;
  label: string;
  status: WorkstreamStatus;
  /** One line: what it is waiting on / what is done. */
  detail: string;
  openIssues: string[];
  pendingDecisions: string[];
  waits: Array<{ key: string; subject: string; sinceDays: number; chases: number }>;
}
export const WORKSTREAM_LABEL: Record<Workstream, string> = { id_aml: 'ID / AML', source_of_funds: 'Source of funds', title: 'Title', searches: 'Searches', enquiries: 'Enquiries', mortgage: 'Mortgage / lender', survey: 'Survey / physical condition', leasehold: 'Leasehold', contract: 'Contract', deposit: 'Deposit', chain: 'Chain', report_on_title: 'Report on title', co_ownership: 'Co-ownership', property_forms: 'Property forms', redemption: 'Redemption', lender_consent: "Lender's consent", completion: 'Completion', registration: 'Registration', discharge: 'Discharge' };

const DECISION_WORKSTREAM: Record<string, Workstream> = { id_check: 'id_aml', search: 'searches', enquiry: 'enquiries', mortgage: 'mortgage', title: 'title', report_on_title: 'report_on_title', proof_of_funds: 'source_of_funds', management_pack: 'leasehold', bank_details: 'completion', requisition: 'registration' };
const WAIT_WORKSTREAM: Record<string, Workstream> = { id_check: 'id_aml', search: 'searches', enquiry: 'enquiries', funds: 'completion', registration: 'registration', proof_of_funds: 'source_of_funds', management_pack: 'leasehold' };

const dayAge = (iso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));

export function workstreams(s: MatterState, now: Date = new Date()): WorkstreamView[] {
  const p = profileOf(s.transactionType);
  return workstreamsAll(s, now).filter((w) => p.workstreams.includes(w.id));
}

function workstreamsAll(s: MatterState, now: Date): WorkstreamView[] {
  const p = profileOf(s.transactionType);
  const seller = p.side === 'seller';
  const issues = openIssues(s);
  const decisions = pendingDecisions(s).filter((d) => d.kind !== 'auto_clear');
  const waits = openWaits(s);
  const mk = (id: Workstream, status: WorkstreamStatus, detail: string): WorkstreamView => {
    const oi = issues.filter((i) => ISSUE_KIND_SPEC[i.kind].workstreams.includes(id));
    const pd = decisions.filter((d) => DECISION_WORKSTREAM[d.kind] === id);
    const ws = waits.filter((w) => WAIT_WORKSTREAM[w.key] === id);
    let st = status;
    if (st !== 'complete' && st !== 'not_applicable') {
      if (oi.some((i) => i.gate !== 'none')) st = 'blocked';
      else if (pd.length) st = 'under_review';
      else if (oi.some((i) => i.severity === 'critical')) st = 'at_risk';
    } else if (st === 'complete' && oi.some((i) => i.gate !== 'none')) st = 'blocked';
    return { id, label: WORKSTREAM_LABEL[id], status: st, detail, openIssues: oi.map((i) => i.id), pendingDecisions: pd.map((d) => d.eventId), waits: ws.map((w) => ({ key: w.key, subject: w.subject, sinceDays: dayAge(w.openedAt, now), chases: w.chasesSentAt.length })) };
  };
  const out: WorkstreamView[] = [];
  // ID / AML
  out.push(mk('id_aml', s.idCheck.status === 'not_started' ? 'not_started' : s.idCheck.status === 'requested' ? 'awaiting' : s.idCheck.status === 'flagged' ? 'under_review' : 'complete', s.idCheck.status === 'requested' ? 'ID / AML check requested — awaiting the provider' : s.idCheck.status === 'flagged' ? 'provider result flagged — decision pending' : isResolved(s.idCheck.status) ? `ID / AML ${s.idCheck.status}` : 'not yet requested'));
  // Source of funds
  const pof = s.proofOfFunds;
  out.push(mk('source_of_funds', pof.status === 'not_started' ? (s.requireProofOfFunds ? 'not_started' : 'not_applicable') : pof.status === 'requested' ? 'awaiting' : pof.status === 'submitted' ? 'under_review' : proofOfFundsApproved(s) ? 'complete' : 'blocked', pof.status === 'not_started' ? (s.requireProofOfFunds ? 'proof-of-funds form not yet sent' : 'not required by policy') : pof.status === 'requested' ? `form with the client (round ${pof.rounds})${openPofQueries(s).length ? `, ${openPofQueries(s).length} queries` : ''}` : pof.status === 'submitted' ? `submitted — sign-off pending${openPofQueries(s).length ? ` (${openPofQueries(s).length} open queries)` : ''}${pof.risk === 'enhanced' ? ' · EDD' : ''}` : proofOfFundsApproved(s) ? `signed off ${pof.approvedAt?.slice(0, 10) ?? ''}` : `${pof.resolution} — a new round is needed`));
  // Title
  out.push(mk('title', s.title.status === 'awaiting' ? 'not_started' : s.title.status === 'extracted' ? 'in_progress' : s.title.status === 'flagged' ? 'under_review' : 'complete', s.title.status === 'awaiting' ? 'official copies not yet received' : s.title.status === 'flagged' ? 'register entries flagged — decision pending' : `title ${s.title.status}${s.title.facts?.titleNumber ? ` (${s.title.facts.titleNumber})` : ''}`));
  // Searches
  const req = s.requiredSearches;
  const done = req.filter((t) => isResolved(s.searches[t]?.status));
  const flagged = req.filter((t) => s.searches[t]?.status === 'flagged');
  const ordered = req.filter((t) => s.searches[t] && !isResolved(s.searches[t].status) && s.searches[t].status !== 'flagged');
  out.push(mk('searches', req.length === 0 ? 'not_applicable' : done.length === req.length ? 'complete' : flagged.length ? 'under_review' : ordered.length ? 'awaiting' : 'not_started', req.length === 0 ? 'no searches required' : `${done.length}/${req.length} resolved${ordered.length ? ` · awaiting ${ordered.join(', ')}` : ''}${flagged.length ? ` · ${flagged.join(', ')} flagged` : ''}`));
  // Enquiries (buyer side: ours to the seller; seller side: the buyer's on us)
  if (seller) {
    const inb = Object.values(s.inboundEnquiries);
    const un = inb.filter((q) => !q.repliedAt);
    out.push(mk('enquiries', inb.length === 0 ? (s.contractPack.sentAt ? 'awaiting' : 'not_started') : un.length ? 'in_progress' : 'complete', inb.length === 0 ? (s.contractPack.sentAt ? "pack sent — awaiting the buyer's enquiries" : 'after the contract pack') : `${inb.length - un.length}/${inb.length} replied${un.length ? ` · ${un.length} awaiting our reply (${un.map((q) => q.id).join(', ')})` : ''}`));
  }
  const qs = Object.values(s.enquiries);
  const qOpen = qs.filter((q) => q.status === 'raised');
  const qFlag = qs.filter((q) => q.status === 'flagged');
  if (!seller) out.push(mk('enquiries', qs.length === 0 ? (s.stage === 'instruction' ? 'not_started' : 'not_applicable') : qOpen.length ? 'awaiting' : qFlag.length ? 'under_review' : 'complete', qs.length === 0 ? 'no enquiries raised' : `${qs.filter((q) => isResolved(q.status)).length}/${qs.length} satisfied${qOpen.length ? ` · ${qOpen.length} outstanding (${qOpen.map((q) => q.enquiryId).join(', ')})` : ''}${qFlag.length ? ` · ${qFlag.length} under review` : ''}`));
  // Mortgage
  const m = s.mortgage;
  const expiry = m.facts?.expiryDate;
  const daysToExpiry = expiry ? Math.round((Date.parse(expiry) - now.getTime()) / 86_400_000) : null;
  out.push(mk('mortgage', !s.hasLender ? 'not_applicable' : m.status === 'awaiting' ? 'awaiting' : m.status === 'flagged' ? 'under_review' : isResolved(m.status) ? (daysToExpiry != null && daysToExpiry <= 30 && !s.exchange.exchangedAt ? 'at_risk' : 'complete') : 'in_progress', !s.hasLender ? 'cash purchase' : m.status === 'awaiting' ? 'offer awaited' : m.status === 'flagged' ? 'conditions flagged — decision pending' : isResolved(m.status) ? `offer ${m.status}${m.facts?.lender ? ` (${m.facts.lender})` : ''}${expiry ? `, expires ${expiry}${daysToExpiry != null ? ` (${daysToExpiry} days)` : ''}` : ''}` : `offer ${m.status}`));
  // Survey
  const sv = s.survey;
  out.push(mk('survey', sv.status === 'not_started' ? 'not_applicable' : sv.status === 'further_investigation' ? 'blocked' : sv.status === 'awaiting_client' ? 'awaiting' : sv.status === 'client_satisfied' ? 'complete' : 'in_progress', sv.status === 'not_started' ? 'no survey on file (the client may not have one)' : sv.status === 'further_investigation' ? 'further specialist investigation recommended' : sv.status === 'awaiting_client' ? `${sv.reports.length} report${sv.reports.length === 1 ? '' : 's'} read — awaiting the client\'s decision` : sv.status === 'client_satisfied' ? 'client satisfied with the physical condition' : sv.status.replace(/_/g, ' ')));
  // Leasehold
  const mp = s.managementPack;
  out.push(mk('leasehold', !isLeasehold(s) ? 'not_applicable' : mp.status === 'not_started' ? 'not_started' : mp.status === 'requested' ? 'awaiting' : mp.status === 'flagged' ? 'under_review' : 'complete', !isLeasehold(s) ? 'freehold' : mp.status === 'not_started' ? 'management pack not requested' : mp.status === 'requested' ? 'management pack awaited' : mp.status === 'flagged' ? 'management pack under review' : 'management pack reviewed'));
  // Property forms (sale)
  out.push(mk('property_forms', s.propertyForms.status === 'not_required' ? 'not_applicable' : s.propertyForms.status === 'received' ? 'complete' : s.propertyForms.status === 'requested' ? 'awaiting' : 'not_started', s.propertyForms.status === 'received' ? `${s.propertyForms.forms.join(', ')} received` : s.propertyForms.status === 'requested' ? `${s.propertyForms.forms.join(', ')} with the client` : 'protocol forms not yet requested'));
  // Redemption (sale / remortgage) and discharge
  const rd = s.redemption;
  out.push(mk('redemption', rd.status === 'not_required' ? 'not_applicable' : rd.status === 'not_started' ? 'not_started' : rd.status === 'requested' ? 'awaiting' : rd.status === 'received' ? (rd.validUntil && Date.parse(rd.validUntil) < now.getTime() ? 'at_risk' : 'complete') : 'complete', rd.status === 'not_required' ? 'unencumbered' : rd.status === 'not_started' ? 'redemption statement not requested' : rd.status === 'requested' ? `statement awaited from ${rd.lender ?? 'the lender'}` : rd.status === 'received' ? `${rd.redemptionPennies != null ? `£${(rd.redemptionPennies / 100).toLocaleString('en-GB')}` : 'figure'} valid to ${rd.validUntil ?? '?'}` : `redeemed ${rd.redeemedAt?.slice(0, 10) ?? ''}`));
  out.push(mk('discharge', rd.status === 'not_required' ? 'not_applicable' : rd.status === 'discharged' ? 'complete' : rd.status === 'redeemed' ? 'awaiting' : 'not_started', rd.status === 'discharged' ? `discharge confirmed ${rd.dischargedAt?.slice(0, 10) ?? ''}` : rd.status === 'redeemed' ? 'awaiting DS1 / e-DS1 from the lender' : 'after redemption'));
  // Lender's consent (transfer of equity)
  const lc = s.lenderConsent;
  out.push(mk('lender_consent', lc.status === 'not_required' ? 'not_applicable' : lc.status === 'received' ? 'complete' : lc.status === 'requested' ? 'awaiting' : 'not_started', lc.status === 'received' ? `consent received${lc.conditions ? ` (conditions: ${lc.conditions.slice(0, 80)})` : ''}` : lc.status === 'requested' ? `awaiting ${lc.lender ?? 'the lender'}` : 'consent not yet requested'));
  // Co-ownership (joint clients on a purchase / transfer)
  const ob = s.clientDecisions.ownership_basis?.decision ?? null;
  out.push(mk('co_ownership', s.parties < 2 ? 'not_applicable' : !ob ? 'awaiting' : deedOfTrustApplies(s) && !s.deeds.deedOfTrustAt ? 'in_progress' : 'complete', s.parties < 2 ? 'single client' : !ob ? `${s.parties} clients — how they hold not yet decided` : `${ob.replace(/_/g, ' ')}${deedOfTrustApplies(s) ? (s.deeds.deedOfTrustAt ? ' · declaration of trust executed' : ' · declaration of trust needed') : ''}`));
  // Contract
  const r = s.readiness;
  if (seller) out.push(mk('contract', s.exchange.exchangedAt ? 'complete' : s.contractPack.sentAt ? (r.signedContractHeldAt ? 'complete' : 'in_progress') : 'not_started', s.exchange.exchangedAt ? `exchanged ${s.exchange.exchangedAt.slice(0, 10)}` : s.contractPack.sentAt ? `contract pack sent ${s.contractPack.sentAt.slice(0, 10)}${r.signedContractHeldAt ? ' · signed part held' : ''}` : 'contract pack not sent'));
  else out.push(mk('contract', s.exchange.exchangedAt ? 'complete' : r.signedContractHeldAt ? 'complete' : r.contractApprovedAt ? 'in_progress' : s.stage === 'instruction' || s.stage === 'pre_contract' ? 'not_started' : 'in_progress', s.exchange.exchangedAt ? `exchanged ${s.exchange.exchangedAt.slice(0, 10)}` : r.signedContractHeldAt ? 'signed contract held' : r.contractApprovedAt ? 'contract approved — signed part awaited' : 'draft contract not yet approved'));
  // Deposit
  out.push(mk('deposit', s.deposit.received ? 'complete' : s.stage === 'instruction' || s.stage === 'pre_contract' ? 'not_started' : 'awaiting', s.deposit.received ? `deposit received ${s.deposit.at?.slice(0, 10) ?? ''}` : 'deposit not yet received'));
  // Chain (only issues describe it)
  const chainIssues = issues.filter((i) => ISSUE_KIND_SPEC[i.kind].workstreams.includes('chain'));
  out.push(mk('chain', chainIssues.length ? 'blocked' : 'not_applicable', chainIssues.length ? chainIssues.map((i) => i.title).join('; ') : 'no chain issue recorded'));
  // Report on title
  const rot = s.reportOnTitle;
  out.push(mk('report_on_title', rot.status === 'sent' ? 'complete' : rot.status === 'drafted' ? 'under_review' : rot.status === 'approved' ? 'in_progress' : 'not_started', rot.status === 'sent' ? `sent ${rot.sentAt?.slice(0, 10) ?? ''}` : rot.status === 'drafted' ? 'draft awaiting the conveyancer\'s approval' : rot.status === 'approved' ? 'approved — to be sent' : 'not yet drafted'));
  // Completion
  const c = s.completion;
  if (seller) out.push(mk('completion', c.confirmedAt ? 'complete' : !s.exchange.exchangedAt ? 'not_applicable' : c.fundsReceivedAt ? 'in_progress' : 'awaiting', c.confirmedAt ? `completed ${c.confirmedAt.slice(0, 10)}` : !s.exchange.exchangedAt ? 'after exchange' : c.fundsReceivedAt ? "buyer's money in — redeem, account and confirm" : `awaiting the buyer's solicitor's money for ${s.exchange.completionDate ?? 'completion'}`));
  else if (!p.hasExchange) out.push(mk('completion', c.confirmedAt ? 'complete' : s.stage === 'pre_completion' ? 'in_progress' : 'not_started', c.confirmedAt ? `completed ${c.confirmedAt.slice(0, 10)}` : s.stage === 'pre_completion' ? 'deeds and money' : 'after investigation'));
  else out.push(mk('completion', c.confirmedAt ? 'complete' : !s.exchange.exchangedAt ? 'not_applicable' : c.fundsReceivedAt ? 'in_progress' : c.fundsRequestedAt ? 'awaiting' : 'not_started', c.confirmedAt ? `completed ${c.confirmedAt.slice(0, 10)}` : !s.exchange.exchangedAt ? 'after exchange' : c.fundsReceivedAt ? 'funds in — completion to confirm' : c.fundsRequestedAt ? 'funds requested' : `completion ${s.exchange.completionDate ?? 'date tbc'}`));
  // Registration
  const pc = s.postCompletion;
  out.push(mk('registration', pc.ap1ConfirmedAt ? 'complete' : !c.confirmedAt ? 'not_applicable' : pc.requisitions.some((x) => !x.respondedAt) ? 'under_review' : pc.ap1SubmittedAt ? 'awaiting' : 'not_started', pc.ap1ConfirmedAt ? 'registered' : !c.confirmedAt ? 'after completion' : pc.requisitions.some((x) => !x.respondedAt) ? 'HMLR requisition outstanding' : pc.ap1SubmittedAt ? 'AP1 lodged — awaiting HMLR' : `${pc.sdltSubmittedAt ? 'SDLT filed · ' : 'SDLT due · '}AP1 not yet lodged`));
  return out;
}

// ───────────────────────────── 3 · requirements, gates, authority ─────────────────────────────

export type Authority = 'system' | 'conveyancer' | 'client' | 'third_party';
export type GateId = 'exchange' | 'completion' | 'registration' | 'close';
export interface Blocker {
  type: 'issue' | 'decision' | 'wait' | 'policy' | 'client' | 'fact';
  id: string;
  label: string;
}
export interface Requirement {
  id: string;
  label: string;
  gate: GateId;
  workstream: Workstream | null;
  /** Who, or what, is authorised to say it is satisfied. */
  authority: Authority;
  humanConfirmationRequired: boolean;
  applies: boolean;
  /** Shown as expected but not enforced by the machine (firms differ): never counts against readiness. */
  advisory?: boolean;
  satisfied: boolean;
  satisfiedAt: string | null;
  blockedBy: Blocker[];
  detail: string;
}

export function requirements(s: MatterState): Requirement[] {
  const p = profileOf(s.transactionType);
  const buyer = p.side === 'buyer';
  const seller = p.side === 'seller';
  const remo = p.type === 'remortgage';
  const toe = p.type === 'transfer_of_equity';
  const issues = openIssues(s);
  const decisions = pendingDecisions(s).filter((d) => d.kind !== 'auto_clear');
  const waits = openWaits(s);
  const issueBlockers = (ws: Workstream | null, gate: 'exchange' | 'completion' | 'registration'): Blocker[] => issues.filter((i) => i.gate !== 'none' && ISSUE_KIND_SPEC[i.kind].threatens.includes(gate) && (ws === null || ISSUE_KIND_SPEC[i.kind].workstreams.includes(ws))).map((i) => ({ type: 'issue', id: i.id, label: `${ISSUE_KIND_SPEC[i.kind].label}: ${i.title}` }));
  const decisionBlockers = (kinds: string[]): Blocker[] => decisions.filter((d) => kinds.includes(d.kind)).map((d) => ({ type: 'decision', id: d.eventId, label: `${d.kind.replace(/_/g, ' ')} decision pending${d.subject ? ` (${d.subject})` : ''}` }));
  const waitBlockers = (keys: string[]): Blocker[] => waits.filter((w) => keys.includes(w.key)).map((w) => ({ type: 'wait', id: `${w.key}:${w.subject}`, label: `awaiting ${w.key.replace(/_/g, ' ')}${w.subject ? ` ${w.subject}` : ''} (chased ${w.chasesSentAt.length}×)` }));
  // A remortgage or transfer of equity has no exchange: everything that would be "ready to exchange" is part of "ready to complete".
  const R = (r: Omit<Requirement, 'satisfiedAt'> & { satisfiedAt?: string | null }): Requirement => ({ satisfiedAt: null, ...r, gate: !p.hasExchange && r.gate === 'exchange' ? 'completion' : r.gate });
  const out: Requirement[] = [];

  // ── exchange gate ──
  out.push(R({ id: 'id_aml_passed', label: 'ID / AML check passed', gate: 'exchange', workstream: 'id_aml', authority: s.idCheck.status === 'cleared' ? 'system' : 'conveyancer', humanConfirmationRequired: false, applies: true, satisfied: isResolved(s.idCheck.status), blockedBy: isResolved(s.idCheck.status) ? [] : [...decisionBlockers(['id_check']), ...waitBlockers(['id_check']), ...(s.idCheck.status === 'not_started' ? [{ type: 'fact' as const, id: 'id_check', label: 'ID check not yet requested' }] : [])], detail: s.idCheck.status === 'cleared' ? 'cleared by the rule layer from the provider result' : s.idCheck.status === 'reviewed' ? 'reviewed by a conveyancer' : `status: ${s.idCheck.status.replace(/_/g, ' ')}` }));
  out.push(R({ id: 'source_of_funds_satisfactory', label: 'Source of funds satisfactory', gate: 'exchange', workstream: 'source_of_funds', authority: 'conveyancer', humanConfirmationRequired: true, applies: buyer && (s.requireProofOfFunds || s.proofOfFunds.status !== 'not_started'), satisfied: proofOfFundsApproved(s), satisfiedAt: s.proofOfFunds.approvedAt, blockedBy: proofOfFundsApproved(s) ? [] : [...decisionBlockers(['proof_of_funds']), ...waitBlockers(['proof_of_funds']), ...openPofQueries(s).map((q) => ({ type: 'client' as const, id: q.id, label: `query ${q.id} ${q.status}: ${q.question.slice(0, 80)}` })), ...(s.proofOfFunds.status === 'not_started' ? [{ type: 'policy' as const, id: 'pof', label: 'proof-of-funds form not yet sent (firm policy)' }] : []), ...issueBlockers('source_of_funds', 'exchange')], detail: 'the conveyancer signs off the declaration and the statements; AML sign-off is never automated' }));
  out.push(R({ id: 'title_satisfactory', label: seller ? 'Title deduced (official copies on file, resolved)' : 'Title satisfactory', gate: p.hasExchange ? 'exchange' : 'completion', workstream: 'title', authority: s.title.status === 'cleared' ? 'system' : 'conveyancer', humanConfirmationRequired: false, applies: true, satisfied: isResolved(s.title.status) && issueBlockers('title', 'exchange').length === 0, blockedBy: [...(isResolved(s.title.status) ? [] : [...decisionBlockers(['title']), ...(s.title.status === 'awaiting' ? [{ type: 'fact' as const, id: 'title', label: 'official copies not yet received' }] : [])]), ...issueBlockers('title', 'exchange')], detail: 'register entries cleared by rule or reviewed by a conveyancer, and no open title issue' }));
  const searchesOk = s.requiredSearches.every((t) => isResolved(s.searches[t]?.status));
  out.push(R({ id: 'searches_satisfactory', label: 'Searches satisfactory', gate: p.hasExchange ? 'exchange' : 'completion', workstream: 'searches', authority: s.requiredSearches.every((t) => s.searches[t]?.status === 'cleared') ? 'system' : 'conveyancer', humanConfirmationRequired: false, applies: !seller && s.requiredSearches.length > 0, satisfied: searchesOk && issueBlockers('searches', 'exchange').length === 0, blockedBy: [...(searchesOk ? [] : [...decisionBlockers(['search']), ...waitBlockers(['search']), ...s.requiredSearches.filter((t) => !s.searches[t]).map((t) => ({ type: 'fact' as const, id: t, label: `${t} search not ordered` }))]), ...issueBlockers('searches', 'exchange')], detail: `${s.requiredSearches.filter((t) => isResolved(s.searches[t]?.status)).length}/${s.requiredSearches.length} resolved` }));
  const enquiriesOk = Object.values(s.enquiries).every((q) => isResolved(q.status));
  out.push(R({ id: 'enquiries_satisfied', label: 'Enquiries satisfied', gate: 'exchange', workstream: 'enquiries', authority: 'conveyancer', humanConfirmationRequired: false, applies: buyer && Object.keys(s.enquiries).length > 0, satisfied: enquiriesOk && issueBlockers('enquiries', 'exchange').length === 0, blockedBy: [...(enquiriesOk ? [] : [...decisionBlockers(['enquiry']), ...waitBlockers(['enquiry'])]), ...issueBlockers('enquiries', 'exchange')], detail: `${Object.values(s.enquiries).filter((q) => isResolved(q.status)).length}/${Object.keys(s.enquiries).length} satisfied` }));
  const offerOk = !s.hasLender || isResolved(s.mortgage.status);
  out.push(R({ id: 'mortgage_offer_valid', label: 'Valid mortgage offer', gate: p.hasExchange ? 'exchange' : 'completion', workstream: 'mortgage', authority: s.mortgage.status === 'cleared' ? 'system' : 'conveyancer', humanConfirmationRequired: false, applies: (buyer || remo) && s.hasLender, satisfied: offerOk && issueBlockers('mortgage', 'exchange').length === 0, blockedBy: [...(offerOk ? [] : [...decisionBlockers(['mortgage']), ...(s.mortgage.status === 'awaiting' ? [{ type: 'fact' as const, id: 'offer', label: 'offer not yet received (or withdrawn)' }] : [])]), ...issueBlockers('mortgage', 'exchange')], detail: s.mortgage.facts?.expiryDate ? `expires ${s.mortgage.facts.expiryDate}` : s.hasLender ? `offer ${s.mortgage.status}` : 'cash purchase' }));
  out.push(R({ id: 'management_pack_reviewed', label: seller ? 'Management pack obtained for the buyer' : 'Management pack reviewed', gate: 'exchange', workstream: 'leasehold', authority: 'conveyancer', humanConfirmationRequired: true, applies: isLeasehold(s) && p.hasExchange, satisfied: isResolved(s.managementPack.status) && issueBlockers('leasehold', 'exchange').length === 0, blockedBy: [...(isResolved(s.managementPack.status) ? [] : [...decisionBlockers(['management_pack']), ...waitBlockers(['management_pack']), ...(s.managementPack.status === 'not_started' ? [{ type: 'fact' as const, id: 'pack', label: 'management pack not requested' }] : [])]), ...issueBlockers('leasehold', 'exchange')], detail: 'leasehold only' }));
  out.push(R({ id: 'report_on_title_sent', label: 'Report on title approved and sent', gate: 'exchange', workstream: 'report_on_title', authority: 'conveyancer', humanConfirmationRequired: true, applies: buyer, satisfied: s.reportOnTitle.status === 'sent', satisfiedAt: s.reportOnTitle.sentAt, blockedBy: s.reportOnTitle.status === 'sent' ? [] : [...decisionBlockers(['report_on_title']), ...(s.reportOnTitle.status === 'not_started' ? [{ type: 'fact' as const, id: 'rot', label: 'not yet drafted (needs title, searches and enquiries resolved)' }] : s.reportOnTitle.status === 'approved' ? [{ type: 'fact' as const, id: 'rot', label: 'approved — not yet sent' }] : [])], detail: 'the AI draft is approved by a conveyancer before it is sent; the database refuses a send without the approval' }));
  out.push(R({ id: 'physical_condition_accepted', label: 'Client satisfied with the physical condition', gate: 'exchange', workstream: 'survey', authority: 'client', humanConfirmationRequired: true, applies: buyer && surveyApplies(s), satisfied: s.survey.status === 'client_satisfied', satisfiedAt: s.clientDecisions.physical_condition?.decision === 'satisfied' ? s.clientDecisions.physical_condition.at : null, blockedBy: s.survey.status === 'client_satisfied' ? [] : [...issueBlockers('survey', 'exchange'), ...(s.survey.status === 'awaiting_client' ? [{ type: 'client' as const, id: 'physical_condition', label: 'the client has not yet said they are satisfied' }] : s.survey.status === 'client_renegotiating' ? [{ type: 'client' as const, id: 'physical_condition', label: 'the client is renegotiating' }] : [])], detail: 'the facts (reports, recommendations) are automated; the satisfaction is the client\'s and is recorded from their instruction' }));
  out.push(R({ id: 'no_blocking_issues', label: 'No unresolved blocking issue', gate: p.hasExchange ? 'exchange' : 'completion', workstream: null, authority: 'conveyancer', humanConfirmationRequired: false, applies: true, satisfied: issues.every((i) => i.gate !== 'exchange'), blockedBy: issues.filter((i) => i.gate === 'exchange').map((i) => ({ type: 'issue' as const, id: i.id, label: `${ISSUE_KIND_SPEC[i.kind].label}: ${i.title} (${i.status}, ${i.severity})` })), detail: 'every issue holding exchange resolved, withdrawn, or its hold released with a note' }));
  out.push(R({ id: 'deposit_confirmed', label: 'Deposit confirmed', gate: 'exchange', workstream: 'deposit', authority: 'system', humanConfirmationRequired: false, applies: buyer, satisfied: s.deposit.received, satisfiedAt: s.deposit.at, blockedBy: s.deposit.received ? [] : [{ type: 'fact', id: 'deposit', label: 'deposit not yet received' }, ...issueBlockers('deposit', 'exchange')], detail: 'recorded when the money arrives' }));
  out.push(R({ id: 'contract_signed', label: 'Contract approved and signed part held', gate: 'exchange', workstream: 'contract', authority: 'conveyancer', humanConfirmationRequired: true, applies: p.hasExchange, advisory: true, satisfied: !!s.readiness.signedContractHeldAt || !!s.exchange.exchangedAt, satisfiedAt: s.readiness.signedContractHeldAt, blockedBy: s.readiness.signedContractHeldAt || s.exchange.exchangedAt ? [] : [{ type: 'fact', id: 'contract', label: s.readiness.contractApprovedAt ? 'signed contract not yet held' : 'contract not yet approved' }], detail: 'advisory in the engine (firms differ on exchanging on an undertaking); shown here as the expected requirement' }));
  out.push(R({ id: 'client_authorises_exchange', label: 'Client authorises exchange', gate: 'exchange', workstream: 'contract', authority: 'client', humanConfirmationRequired: true, applies: p.hasExchange && s.requireExchangeAuthority, satisfied: s.clientDecisions.exchange_authority?.decision === 'authorised', satisfiedAt: s.clientDecisions.exchange_authority?.decision === 'authorised' ? s.clientDecisions.exchange_authority.at : null, blockedBy: s.clientDecisions.exchange_authority?.decision === 'authorised' ? [] : [{ type: 'client', id: 'exchange_authority', label: 'the client\'s instruction to exchange has not been recorded' }], detail: 'recorded by a person from the client\'s instruction; never inferred' }));

  // ── sale side: exchange gate ──
  out.push(R({ id: 'property_forms_received', label: 'Property forms (TA6 / TA10 / TA7) received from the client', gate: 'exchange', workstream: 'property_forms', authority: 'system', humanConfirmationRequired: false, applies: seller, satisfied: s.propertyForms.status === 'received', blockedBy: s.propertyForms.status === 'received' ? [] : [...waitBlockers(['property_forms']), ...(s.propertyForms.status === 'not_started' ? [{ type: 'fact' as const, id: 'forms', label: 'forms not yet requested' }] : []), ...issueBlockers('property_forms', 'exchange')], detail: 'the seller\'s answers are the seller\'s; the conveyancer sends them on' }));
  out.push(R({ id: 'contract_pack_sent', label: 'Contract pack sent to the buyer\'s solicitor', gate: 'exchange', workstream: 'contract', authority: 'conveyancer', humanConfirmationRequired: false, applies: seller, satisfied: !!s.contractPack.sentAt, satisfiedAt: s.contractPack.sentAt, blockedBy: s.contractPack.sentAt ? [] : [{ type: 'fact', id: 'pack', label: s.propertyForms.status !== 'received' ? 'waiting for the property forms' : s.title.status === 'awaiting' ? 'waiting for official copies' : 'not yet sent' }], detail: '' }));
  const unreplied = Object.values(s.inboundEnquiries).filter((q) => !q.repliedAt);
  out.push(R({ id: 'buyer_enquiries_replied', label: 'Buyer\'s enquiries replied to', gate: 'exchange', workstream: 'enquiries', authority: 'conveyancer', humanConfirmationRequired: true, applies: seller && Object.keys(s.inboundEnquiries).length > 0, satisfied: unreplied.length === 0, blockedBy: unreplied.map((q) => ({ type: 'fact' as const, id: q.id, label: `${q.id}: ${q.question.slice(0, 80)}` })), detail: 'replies carry the client\'s answers; a person sends them' }));
  out.push(R({ id: 'redemption_known', label: 'Redemption figure known', gate: p.hasExchange ? 'exchange' : 'completion', workstream: 'redemption', authority: 'third_party', humanConfirmationRequired: false, applies: (seller || remo) && s.hasExistingMortgage, satisfied: ['received', 'redeemed', 'discharged'].includes(s.redemption.status), blockedBy: ['received', 'redeemed', 'discharged'].includes(s.redemption.status) ? [] : [...waitBlockers(['redemption']), ...(s.redemption.status === 'not_started' ? [{ type: 'fact' as const, id: 'redemption', label: 'redemption statement not requested' }] : [])], detail: s.redemption.validUntil ? `valid to ${s.redemption.validUntil}` : '' }));
  // ── remortgage / transfer: completion gate ──
  out.push(R({ id: 'lender_consent', label: 'Lender\'s consent to the transfer', gate: 'completion', workstream: 'lender_consent', authority: 'third_party', humanConfirmationRequired: false, applies: toe && s.hasExistingMortgage, satisfied: s.lenderConsent.status === 'received', satisfiedAt: s.lenderConsent.receivedAt, blockedBy: s.lenderConsent.status === 'received' ? [] : [...waitBlockers(['lender_consent']), ...(s.lenderConsent.status === 'not_started' ? [{ type: 'fact' as const, id: 'consent', label: 'consent not yet requested' }] : [])], detail: s.lenderConsent.conditions ?? '' }));
  out.push(R({ id: 'ownership_basis_decided', label: 'Clients decided how they hold (joint tenants / tenants in common)', gate: 'completion', workstream: 'co_ownership', authority: 'client', humanConfirmationRequired: true, applies: s.parties > 1 && (buyer || toe), satisfied: !!s.clientDecisions.ownership_basis, satisfiedAt: s.clientDecisions.ownership_basis?.at ?? null, blockedBy: s.clientDecisions.ownership_basis ? [] : [{ type: 'client', id: 'ownership_basis', label: 'the clients\' decision on co-ownership has not been recorded' }], detail: 'the clients\' decision, recorded from their instruction (advised separately where their interests differ)' }));
  out.push(R({ id: 'deed_of_trust', label: 'Declaration of trust executed', gate: 'completion', workstream: 'co_ownership', authority: 'system', humanConfirmationRequired: false, applies: deedOfTrustApplies(s) && (buyer || toe), satisfied: !!s.deeds.deedOfTrustAt, satisfiedAt: s.deeds.deedOfTrustAt, blockedBy: s.deeds.deedOfTrustAt ? [] : [{ type: 'fact', id: 'dot', label: 'tenants in common: the declaration of trust is not yet executed' }], detail: '' }));
  out.push(R({ id: 'mortgage_deed', label: 'Mortgage deed executed', gate: 'completion', workstream: 'mortgage', authority: 'system', humanConfirmationRequired: false, applies: s.hasLender && (remo || buyer), advisory: buyer, satisfied: !!s.deeds.mortgageDeedAt, satisfiedAt: s.deeds.mortgageDeedAt, blockedBy: s.deeds.mortgageDeedAt ? [] : [{ type: 'fact', id: 'deed', label: 'not yet executed (witnessed)' }], detail: buyer ? 'expected before completion; advisory in the engine' : '' }));
  out.push(R({ id: 'certificate_of_title', label: 'Certificate of title sent to the lender', gate: 'completion', workstream: 'mortgage', authority: 'conveyancer', humanConfirmationRequired: true, applies: s.hasLender && (remo || buyer), advisory: buyer, satisfied: !!s.deeds.certificateOfTitleAt, satisfiedAt: s.deeds.certificateOfTitleAt, blockedBy: s.deeds.certificateOfTitleAt ? [] : [{ type: 'fact', id: 'cot', label: 'not yet sent' }], detail: 'the solicitor\'s certificate; the advance is released against it' }));
  out.push(R({ id: 'transfer_deed', label: 'Transfer deed executed by every party', gate: 'completion', workstream: buyer ? 'contract' : 'co_ownership', authority: 'system', humanConfirmationRequired: false, applies: toe || buyer, advisory: buyer, satisfied: !!s.deeds.transferDeedAt || (buyer && !!s.completion.confirmedAt), satisfiedAt: s.deeds.transferDeedAt, blockedBy: s.deeds.transferDeedAt ? [] : [{ type: 'fact', id: 'tr1', label: 'not yet executed (witnessed)' }], detail: '' }));
  out.push(R({ id: 'redemption_authorised', label: 'Redemption payment authorised against verified lender details', gate: 'completion', workstream: 'redemption', authority: 'conveyancer', humanConfirmationRequired: true, applies: (seller || remo) && s.hasExistingMortgage, satisfied: s.payments.some((x) => x.payeeKind === 'lender') && !decisions.some((d) => d.kind === 'bank_details' && s.bankDetails[d.subject ?? '']?.payeeKind === 'lender'), blockedBy: [...decisions.filter((d) => d.kind === 'bank_details' && s.bankDetails[d.subject ?? '']?.payeeKind === 'lender').map((d) => ({ type: 'decision' as const, id: d.eventId, label: 'lender bank-details change awaiting out-of-band verification (hard stop)' })), ...(s.payments.some((x) => x.payeeKind === 'lender') ? [] : [{ type: 'fact' as const, id: 'redeem', label: Object.values(s.bankDetails).some((b) => b.payeeKind === 'lender' && b.status === 'verified') ? 'not yet authorised' : 'no verified lender bank details on file' }])], detail: 'the same hard stop as the completion payment on a purchase' }));

  // ── completion gate ──
  out.push(R({ id: 'exchanged', label: 'Contracts exchanged', gate: 'completion', workstream: 'contract', authority: 'system', humanConfirmationRequired: false, applies: p.hasExchange, satisfied: !!s.exchange.exchangedAt, satisfiedAt: s.exchange.exchangedAt, blockedBy: s.exchange.exchangedAt ? [] : [{ type: 'fact', id: 'exchange', label: 'not yet exchanged' }], detail: s.exchange.completionDate ? `completion ${s.exchange.completionDate}` : '' }));
  out.push(R({ id: 'completion_statement', label: 'Completion statement produced', gate: 'completion', workstream: 'completion', authority: 'system', humanConfirmationRequired: false, applies: p.hasExchange, satisfied: !!s.completion.statementGeneratedAt, satisfiedAt: s.completion.statementGeneratedAt, blockedBy: s.completion.statementGeneratedAt ? [] : [{ type: 'fact', id: 'statement', label: 'not yet generated' }], detail: '' }));
  const sellerBank = Object.values(s.bankDetails).filter((b) => b.payeeKind === 'seller_solicitor');
  const bankPending = decisions.filter((d) => d.kind === 'bank_details');
  out.push(R({ id: 'seller_bank_verified', label: 'Seller\'s solicitor\'s bank details verified out of band', gate: 'completion', workstream: 'completion', authority: 'conveyancer', humanConfirmationRequired: true, applies: buyer, satisfied: sellerBank.some((b) => b.status === 'verified') && bankPending.length === 0, blockedBy: [...bankPending.map((d) => ({ type: 'decision' as const, id: d.eventId, label: 'bank-details change awaiting out-of-band verification (hard stop)' })), ...(sellerBank.length === 0 ? [{ type: 'fact' as const, id: 'bank', label: 'no seller\'s-solicitor bank details on file' }] : [])], detail: 'addendum 2: a hard stop until verified by a named out-of-band method' }));
  out.push(R({ id: 'funds_received', label: seller ? "Completion monies received from the buyer's solicitor" : remo ? 'Advance received from the lender' : toe ? 'Consideration received from the incoming owner' : 'Completion funds received', gate: 'completion', workstream: 'completion', authority: 'system', humanConfirmationRequired: false, applies: !toe || (s.considerationPennies ?? 0) > 0, satisfied: !!s.completion.fundsReceivedAt, satisfiedAt: s.completion.fundsReceivedAt, blockedBy: s.completion.fundsReceivedAt ? [] : [...waitBlockers(['funds']), ...(s.completion.fundsRequestedAt ? [] : [{ type: 'fact' as const, id: 'funds', label: 'funds not yet requested' }]), ...issueBlockers('completion', 'completion')], detail: '' }));
  out.push(R({ id: 'payment_authorised', label: 'Completion payment authorised by a person', gate: 'completion', workstream: 'completion', authority: 'conveyancer', humanConfirmationRequired: true, applies: buyer, satisfied: s.payments.some((p) => p.payeeKind === 'seller_solicitor' && p.purpose === 'completion_monies'), blockedBy: s.payments.some((p) => p.payeeKind === 'seller_solicitor' && p.purpose === 'completion_monies') ? [] : [{ type: 'fact', id: 'payment', label: 'not yet authorised against verified details' }], detail: 'the database refuses a payment written by automation' }));
  out.push(R({ id: 'no_completion_issues', label: 'No unresolved issue holding completion', gate: 'completion', workstream: null, authority: 'conveyancer', humanConfirmationRequired: false, applies: true, satisfied: issues.every((i) => i.gate !== 'completion'), blockedBy: issues.filter((i) => i.gate === 'completion').map((i) => ({ type: 'issue' as const, id: i.id, label: `${ISSUE_KIND_SPEC[i.kind].label}: ${i.title}` })), detail: '' }));

  // ── registration gate ──
  out.push(R({ id: 'completed', label: 'Completed', gate: 'registration', workstream: 'completion', authority: 'system', humanConfirmationRequired: false, applies: true, satisfied: !!s.completion.confirmedAt, satisfiedAt: s.completion.confirmedAt, blockedBy: s.completion.confirmedAt ? [] : [{ type: 'fact', id: 'completion', label: 'not yet completed' }], detail: '' }));
  out.push(R({ id: 'sdlt_filed', label: toe ? 'SDLT filed, or recorded as not required' : 'SDLT return filed (14 days)', gate: 'registration', workstream: 'registration', authority: toe ? 'conveyancer' : 'system', humanConfirmationRequired: toe, applies: buyer || (toe && (s.considerationPennies ?? 0) > 0), satisfied: !!s.postCompletion.sdltSubmittedAt || !!s.sdltNotRequiredAt, satisfiedAt: s.postCompletion.sdltSubmittedAt, blockedBy: s.postCompletion.sdltSubmittedAt ? [] : [{ type: 'fact', id: 'sdlt', label: 'not yet filed' }], detail: '' }));
  out.push(R({ id: 'ap1_lodged', label: remo ? 'AP1 lodged (new charge)' : 'AP1 lodged', gate: 'registration', workstream: 'registration', authority: 'system', humanConfirmationRequired: false, applies: p.registration === 'ap1', satisfied: !!s.postCompletion.ap1SubmittedAt, satisfiedAt: s.postCompletion.ap1SubmittedAt, blockedBy: s.postCompletion.ap1SubmittedAt ? [] : [{ type: 'fact', id: 'ap1', label: 'not yet lodged' }], detail: '' }));
  out.push(R({ id: 'requisitions_answered', label: 'HMLR requisitions answered', gate: 'registration', workstream: 'registration', authority: 'conveyancer', humanConfirmationRequired: true, applies: s.postCompletion.requisitions.length > 0, satisfied: s.postCompletion.requisitions.every((r) => r.respondedAt), blockedBy: [...decisionBlockers(['requisition'])], detail: '' }));
  out.push(R({ id: 'registered', label: 'Registration confirmed', gate: 'registration', workstream: 'registration', authority: 'third_party', humanConfirmationRequired: false, applies: p.registration === 'ap1', satisfied: !!s.postCompletion.ap1ConfirmedAt, satisfiedAt: s.postCompletion.ap1ConfirmedAt, blockedBy: s.postCompletion.ap1ConfirmedAt ? [] : [...waitBlockers(['registration']), ...issueBlockers(null, 'registration')], detail: 'HM Land Registry' }));
  // ── sale / remortgage: discharge (the seller's "registration") ──
  out.push(R({ id: 'mortgage_redeemed', label: 'Mortgage redeemed', gate: 'registration', workstream: 'redemption', authority: 'system', humanConfirmationRequired: false, applies: (seller || remo) && s.hasExistingMortgage, satisfied: s.redemption.status === 'redeemed' || s.redemption.status === 'discharged', satisfiedAt: s.redemption.redeemedAt, blockedBy: s.redemption.status === 'redeemed' || s.redemption.status === 'discharged' ? [] : [{ type: 'fact', id: 'redeemed', label: s.completion.confirmedAt ? 'not yet recorded as redeemed' : 'after completion' }], detail: '' }));
  out.push(R({ id: 'balance_to_client', label: 'Balance paid to the client against verified details', gate: 'registration', workstream: 'completion', authority: 'conveyancer', humanConfirmationRequired: true, applies: seller, satisfied: s.payments.some((x) => x.payeeKind === 'client'), blockedBy: s.payments.some((x) => x.payeeKind === 'client') ? [] : [{ type: 'fact', id: 'balance', label: Object.values(s.bankDetails).some((b) => b.payeeKind === 'client' && b.status === 'verified') ? 'not yet authorised' : 'client\'s bank details not yet verified out of band' }], detail: 'the client\'s own details are a hard stop too' }));
  out.push(R({ id: 'discharge_confirmed', label: 'Lender\'s discharge confirmed (DS1 / e-DS1)', gate: 'registration', workstream: 'discharge', authority: 'third_party', humanConfirmationRequired: false, applies: (seller || remo) && s.hasExistingMortgage, satisfied: s.redemption.status === 'discharged', satisfiedAt: s.redemption.dischargedAt, blockedBy: s.redemption.status === 'discharged' ? [] : [...waitBlockers(['discharge']), ...(s.redemption.status !== 'redeemed' ? [{ type: 'fact' as const, id: 'discharge', label: 'after redemption' }] : [])], detail: '' }));
  // ── close ──
  out.push(R({ id: 'notice_of_assignment', label: 'Notice of assignment served', gate: 'close', workstream: 'leasehold', authority: 'system', humanConfirmationRequired: false, applies: isLeasehold(s) && buyer, satisfied: !!s.postCompletion.noticeOfAssignmentAt, satisfiedAt: s.postCompletion.noticeOfAssignmentAt, blockedBy: s.postCompletion.noticeOfAssignmentAt ? [] : [{ type: 'fact', id: 'noa', label: 'not yet served' }], detail: 'leasehold only' }));
  out.push(R({ id: 'no_open_issues', label: 'No open issues', gate: 'close', workstream: null, authority: 'conveyancer', humanConfirmationRequired: false, applies: true, satisfied: issues.length === 0, blockedBy: issues.map((i) => ({ type: 'issue' as const, id: i.id, label: `${ISSUE_KIND_SPEC[i.kind].label}: ${i.title}` })), detail: '' }));
  return out;
}

export interface GateView {
  id: GateId;
  label: string;
  ready: boolean;
  /** Requirements that apply and are not satisfied, each with what it is waiting on. */
  unsatisfied: Requirement[];
  satisfied: Requirement[];
  /** The machine's own blockers for the current stage (what it would actually refuse), for cross-checking. */
  machineBlockers: string[];
}
export const GATE_LABEL: Record<GateId, string> = { exchange: 'Ready to exchange', completion: 'Ready to complete', registration: 'Registered', close: 'File closed' };
/** The registration gate reads "discharged" on the seller's side. */
export const gateLabelFor = (s: MatterState, id: GateId): string => (id === 'registration' && profileOf(s.transactionType).registration === 'discharge_only' ? 'Redeemed, accounted and discharged' : GATE_LABEL[id]);

const GATE_ORDER: GateId[] = ['exchange', 'completion', 'registration', 'close'];
/** The gates this type passes through (no exchange gate on a remortgage / transfer of equity). */
export const gatesFor = (s: MatterState): GateId[] => (profileOf(s.transactionType).hasExchange ? GATE_ORDER : GATE_ORDER.filter((g) => g !== 'exchange'));
export function gate(s: MatterState, id: GateId): GateView {
  const all = requirements(s);
  const reqs = all.filter((r) => r.gate === id && r.applies);
  const unsatisfied = reqs.filter((r) => !r.satisfied && !r.advisory);
  // A gate depends on the ones before it: "ready to complete" presupposes exchanged, and so on.
  const earlier = GATE_ORDER.slice(0, GATE_ORDER.indexOf(id));
  const earlierReady = earlier.every((g) => all.filter((r) => r.gate === g && r.applies && !r.advisory).every((r) => r.satisfied));
  return { id, label: gateLabelFor(s, id), ready: unsatisfied.length === 0 && earlierReady && !s.abandoned && !s.closedAt, unsatisfied, satisfied: reqs.filter((r) => r.satisfied), machineBlockers: stageBlockers(s) };
}

/** "Why is this case not ready to exchange?" — one line per unsatisfied requirement, traced to what it waits on. */
export function whyNot(s: MatterState, id: GateId = 'exchange'): string[] {
  return gate(s, id).unsatisfied.map((r) => `${r.label}: ${r.blockedBy.length ? r.blockedBy.map((b) => b.label).join('; ') : r.detail || 'not yet'}`);
}

// ───────────────────────────── 4 · what next, and who says so ─────────────────────────────

export interface NextAction {
  what: string;
  who: Authority | 'seller_side' | 'lender' | 'mlro';
  /** What it unblocks. */
  unblocks: string;
  ref: { type: Blocker['type'] | 'requirement'; id: string };
  urgency: IssueSeverity;
}

export function nextActions(s: MatterState, now: Date = new Date()): NextAction[] {
  if (s.abandoned || s.closedAt) return [];
  const p = profileOf(s.transactionType);
  const regDone = p.registration === 'ap1' ? !!s.postCompletion.ap1ConfirmedAt : p.registration === 'discharge_only' ? (!s.hasExistingMortgage || s.redemption.status === 'discharged') : true;
  const g: GateId = p.hasExchange && !s.exchange.exchangedAt ? 'exchange' : !s.completion.confirmedAt ? 'completion' : !regDone ? 'registration' : 'close';
  const out: NextAction[] = [];
  const seen = new Set<string>();
  for (const r of gate(s, g).unsatisfied) {
    for (const b of r.blockedBy) {
      const key = `${b.type}:${b.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (b.type === 'issue') {
        const i = s.issues[b.id];
        const spec = ISSUE_KIND_SPEC[i.kind];
        out.push({ what: `${spec.actions[0] ?? 'Deal with'}: ${i.title}`, who: spec.responsible === 'conveyancer' ? 'conveyancer' : spec.responsible === 'client' ? 'client' : spec.responsible === 'third_party' ? 'third_party' : spec.responsible, unblocks: r.label, ref: { type: 'issue', id: i.id }, urgency: i.severity });
      } else if (b.type === 'decision') {
        out.push({ what: `Resolve the ${b.label}`, who: 'conveyancer', unblocks: r.label, ref: { type: 'decision', id: b.id }, urgency: 'warning' });
      } else if (b.type === 'wait') {
        const [key] = b.id.split(':');
        const w = openWaits(s).find((x) => `${x.key}:${x.subject}` === b.id);
        const rule = DEFAULT_SLA[key as keyof typeof DEFAULT_SLA];
        out.push({ what: `${b.label}${w ? ` since ${w.openedAt.slice(0, 10)} (${dayAge(w.openedAt, now)} days)` : ''}`, who: rule?.recipientRole === 'client' ? 'client' : rule?.recipientRole === 'lender' ? 'lender' : rule?.recipientRole === 'seller_solicitor' ? 'seller_side' : 'third_party', unblocks: r.label, ref: { type: 'wait', id: b.id }, urgency: w && w.escalations.some((e) => !e.resolvedAt) ? 'critical' : 'info' });
      } else if (b.type === 'client') {
        out.push({ what: b.label.startsWith('query') ? `Client to answer ${b.label}` : `Take the client's instruction: ${b.label}`, who: 'client', unblocks: r.label, ref: { type: 'client', id: b.id }, urgency: 'warning' });
      } else {
        out.push({ what: b.label, who: r.authority === 'client' ? 'client' : r.authority === 'third_party' ? 'third_party' : r.authority === 'system' ? 'conveyancer' : 'conveyancer', unblocks: r.label, ref: { type: b.type, id: b.id }, urgency: 'info' });
      }
    }
    if (!r.blockedBy.length) out.push({ what: `${r.label}: ${r.detail || 'not yet'}`, who: r.authority, unblocks: gateLabelFor(s, g), ref: { type: 'requirement', id: r.id }, urgency: 'info' });
  }
  const rank: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.urgency] - rank[b.urgency]);
}

// ───────────────────────────── 5 · the dependency graph ─────────────────────────────

export type NodeType = 'case' | 'gate' | 'workstream' | 'requirement' | 'issue' | 'decision' | 'wait' | 'client_decision';
export type EdgeType = 'REQUIRES' | 'BLOCKS' | 'SATISFIES' | 'THREATENS' | 'DEPENDS_ON' | 'DISCOVERED_BY' | 'RELATES_TO' | 'RESOLVED_BY';
export interface GraphNode { id: string; type: NodeType; label: string; status: string; severity?: IssueSeverity; authority?: Authority; workstream?: Workstream | null; detail?: string }
export interface GraphEdge { from: string; to: string; type: EdgeType; label?: string }
export interface CaseGraph { lifecycle: Lifecycle; nodes: GraphNode[]; edges: GraphEdge[] }

export function caseGraph(s: MatterState, now: Date = new Date()): CaseGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const add = (n: GraphNode) => { if (!nodes.some((x) => x.id === n.id)) nodes.push(n); };
  const link = (from: string, to: string, type: EdgeType, label?: string) => { if (!edges.some((e) => e.from === from && e.to === to && e.type === type)) edges.push({ from, to, type, label }); };
  const lc = lifecycle(s);
  add({ id: 'case', type: 'case', label: `Case · ${LIFECYCLE_LABEL[lc]}`, status: lc });
  const gates: GateId[] = gatesFor(s);
  gates.forEach((g, i) => {
    const gv = gate(s, g);
    add({ id: `gate:${g}`, type: 'gate', label: gateLabelFor(s, g), status: gv.ready ? 'ready' : 'not_ready' });
    if (i > 0) link(`gate:${g}`, `gate:${gates[i - 1]}`, 'DEPENDS_ON');
  });
  for (const w of workstreams(s, now)) add({ id: `ws:${w.id}`, type: 'workstream', label: w.label, status: w.status, workstream: w.id, detail: w.detail });
  for (const r of requirements(s)) {
    if (!r.applies) continue;
    add({ id: `req:${r.id}`, type: 'requirement', label: r.label, status: r.satisfied ? 'satisfied' : 'unsatisfied', authority: r.authority, workstream: r.workstream, detail: r.detail });
    link(`gate:${r.gate}`, `req:${r.id}`, 'REQUIRES');
    if (r.workstream) link(`ws:${r.workstream}`, `req:${r.id}`, r.satisfied ? 'SATISFIES' : 'RELATES_TO');
    for (const b of r.blockedBy) {
      if (b.type === 'issue') link(`issue:${b.id}`, `req:${r.id}`, 'BLOCKS');
      else if (b.type === 'decision') { add({ id: `decision:${b.id}`, type: 'decision', label: b.label, status: 'pending', authority: 'conveyancer' }); link(`decision:${b.id}`, `req:${r.id}`, 'BLOCKS'); }
      else if (b.type === 'wait') { add({ id: `wait:${b.id}`, type: 'wait', label: b.label, status: 'open', authority: 'third_party' }); link(`wait:${b.id}`, `req:${r.id}`, 'BLOCKS'); }
      else if (b.type === 'client') { add({ id: `client:${b.id}`, type: 'client_decision', label: b.label, status: 'awaiting', authority: 'client' }); link(`client:${b.id}`, `req:${r.id}`, 'BLOCKS'); }
    }
  }
  for (const i of Object.values(s.issues)) {
    const spec = ISSUE_KIND_SPEC[i.kind];
    add({ id: `issue:${i.id}`, type: 'issue', label: `${i.id} ${spec.label}: ${i.title}`, status: i.status, severity: i.severity, workstream: spec.workstreams[0] ?? null, detail: i.detail ?? undefined });
    for (const ws of spec.workstreams) link(`issue:${i.id}`, `ws:${ws}`, 'RELATES_TO');
    if (i.status === 'open' || i.status === 'negotiating') for (const g of spec.threatens) link(`issue:${i.id}`, `gate:${gates.includes(g) ? g : 'completion'}`, 'THREATENS');
    if (i.causedBy) link(`issue:${i.id}`, `issue:${i.causedBy}`, 'DISCOVERED_BY');
    if (i.origin) link(`issue:${i.id}`, `issue:${i.origin.issueId}`, 'DISCOVERED_BY', i.origin.resolution);
    if (i.resolution) link(`issue:${i.id}`, `issue:${i.id}`, 'RESOLVED_BY', i.resolution);
    for (const q of i.enquiryIds) { add({ id: `enquiry:${q}`, type: 'wait', label: `enquiry ${q}`, status: s.enquiries[q]?.status ?? '' }); link(`enquiry:${q}`, `issue:${i.id}`, 'RELATES_TO'); }
  }
  for (const d of pendingDecisions(s).filter((d) => d.kind !== 'auto_clear')) {
    add({ id: `decision:${d.eventId}`, type: 'decision', label: `${d.kind.replace(/_/g, ' ')}${d.subject ? ` ${d.subject}` : ''}`, status: 'pending', authority: 'conveyancer' });
    const ws = DECISION_WORKSTREAM[d.kind];
    if (ws) link(`decision:${d.eventId}`, `ws:${ws}`, 'RELATES_TO');
  }
  return { lifecycle: lc, nodes, edges };
}

export { WORKSTREAMS };
export type { DecisionState, IssueState, WaitState };
