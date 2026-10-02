/**
 * People events (docs/eventualities/parties.md J4-J7; theme G).
 *
 * A client or the other side dies, loses capacity or becomes bankrupt; the firm's MLRO makes a suspicious
 * activity report; a sanctions screen matches. Each changes who can give instructions, sign and be paid, and
 * whether money may move at all. Pure: the consequences as issues (the machine raises them), and the holds the
 * machine enforces.
 */
import type { IssueGate, IssueKind, IssueSeverity } from './issues';
import { addWorkingDays, EW_CALENDAR } from './working-days';
import type { MatterState } from './types';

export type PartyEvent = 'died' | 'capacity_lost' | 'bankrupt' | 'instructing_for_client' | 'confidence' | 'refuses_to_sign' | 'capacity_doubt' | 'cdd_refused' | 'complaint' | 'withhold_from_lender' | 'gift_withdrawn' | 'uncontactable' | 'moving_firm' | 'ceasing_to_act';
export interface Consequence { kind: IssueKind; title: string; detail: string; gate: IssueGate; severity: IssueSeverity }

/** What a person's death, loss of capacity or bankruptcy means for this case, before or after exchange. */
export function partyEventConsequences(s: MatterState, e: { event: PartyEvent; party: string; hasAttorney: boolean | null }, side: 'buyer' | 'seller' | 'owner'): Consequence[] {
  const exchanged = !!s.exchange.exchangedAt;
  const gate: IssueGate = exchanged ? 'completion' : 'exchange';
  const ours = (s.partyNames ?? []).some((n) => n.trim().toLowerCase() === e.party.trim().toLowerCase());
  const sole = ours && (s.partyNames ?? []).length <= 1;
  const borrower = ours && s.hasLender && (side === 'buyer' || side === 'owner');
  const out: Consequence[] = [];
  const ex = exchanged ? 'completion' as const : 'exchange' as const;
  const lender = (why: string) => { if (borrower) out.push({ kind: 'lender_approval', title: `Tell the lender: ${e.party} ${why}`, detail: `The offer was made to ${e.party} as a borrower. Report it to the lender now; most offers end on a borrower's death or bankruptcy, and a borrower who lacks capacity cannot sign the mortgage deed. Do not draw the advance until the lender confirms in writing.`, gate, severity: 'critical' }); };
  if (e.event === 'died') {
    if (!ours) out.push({ kind: 'probate_issue', title: `${e.party} (the other side) has died`, detail: exchanged ? 'The contract binds their estate: the personal representatives must complete, and cannot sign the transfer until the grant of probate or letters of administration issues. Expect a delay; consider the contractual remedies only with the client\'s instructions.' : 'No contract yet: the sale cannot proceed until the personal representatives have the grant. Ask the other side for the expected timing and tell the client; the dates will move.', gate, severity: 'critical' });
    else if (sole) out.push({ kind: 'probate_issue', title: `Our client ${e.party} has died`, detail: exchanged ? 'The contract binds the estate: the personal representatives complete (we act for them only on fresh instructions and the grant). Stop every message to the client, tell the other side, and re-plan completion.' : 'The retainer ended with the client\'s death. Stop every message to them; tell the other side; hold money on account for the estate and return it to the personal representatives on sight of the grant. Abandon the case (reason: client died) unless the estate instructs us to continue.', gate, severity: 'critical' });
    else out.push({ kind: 'client_change', title: `${e.party} has died`, detail: exchanged ? `The contract binds ${e.party}'s estate with the surviving client. Take the survivor's instructions; their personal representatives join in or the seller agrees a variation; the survivor\'s funding and the SDLT are re-checked.` : `Ask the surviving client whether they still wish to proceed alone. If so, record the clients again (Change Clients): the contract parties, the funding, the lender and the SDLT basis are all redone.`, gate, severity: 'critical' });
    lender('has died');
  } else if (e.event === 'capacity_lost') {
    if (e.hasAttorney) out.push({ kind: 'power_of_attorney_issue', title: `${e.party} has lost capacity: instructions from the attorney`, detail: 'See the registered lasting power of attorney and check it covers property; identify the attorney as a client; they sign in the donor\'s name. A trustee co-owner needs the attorney to have a beneficial interest too (TDA 1999 s.1), or a replacement trustee.', gate, severity: 'critical' });
    else out.push({ kind: 'power_of_attorney_issue', title: `${e.party} has lost capacity and there is no power of attorney`, detail: `No one can give instructions or sign for ${e.party} until the Court of Protection appoints a deputy (usually months). ${exchanged ? 'The contract binds: tell the other side at once and plan for a delayed completion.' : 'Do not exchange; tell the other side and re-plan the dates, or abandon if the delay is unacceptable.'}`, gate, severity: 'critical' });
    lender('has lost capacity');
  } else if (e.event === 'instructing_for_client') {
    out.push({ kind: 'aml_kyc_problem', title: `Instructions coming from ${e.party}, not the client`, detail: `Take instructions from the client themselves: confirm by a call to the number you verified, or in writing, before acting on anything ${e.party} says. If the client wants ${e.party} to speak for them, get it in writing from the client; watch for pressure or undue influence.`, gate: ex, severity: 'warning' });
  } else if (e.event === 'confidence') {
    out.push({ kind: 'joint_client_conflict', title: `${e.party} told us something in confidence that affects the other client`, detail: 'Joint clients have no confidentiality from each other: tell them we cannot keep it from the other client. If they will not agree to it being shared, there is a conflict and we may not be able to act for either (SRA Code 6.2, 6.3).', gate: ex, severity: 'critical' });
  } else if (e.event === 'refuses_to_sign') {
    out.push({ kind: 'joint_client_conflict', title: `${e.party} will not sign`, detail: `Every legal owner must sign${exchanged ? ', and the contract binds them: the buyer may serve a notice to complete' : ''}. Find out why; a co-owner who will not sell may need a court order for sale (TLATA 1996 s.14). Consider whether we can still act for both.`, gate: ex, severity: 'critical' });
  } else if (e.event === 'capacity_doubt') {
    out.push({ kind: 'power_of_attorney_issue', title: `Doubt about ${e.party}'s capacity to instruct`, detail: "See the client on their own, record how they understood the transaction, and get medical evidence of capacity if there is doubt. Watch for a family member driving the sale (undue influence). Do not proceed until satisfied; if they lack capacity, instructions come from an attorney or a deputy.", gate: ex, severity: 'critical' });
  } else if (e.event === 'cdd_refused') {
    out.push({ kind: 'aml_kyc_problem', title: `${e.party} will not provide the identity or source-of-funds evidence`, detail: 'Without customer due diligence we cannot go on (MLR 2017 reg 31): stop work, do not receive or pay money, and consider with the MLRO whether a report is needed. Do not tell the client a report is being considered.', gate: ex, severity: 'critical' });
  } else if (e.event === 'complaint') {
    out.push({ kind: 'complaint', title: `Complaint from ${e.party}`, detail: "Acknowledge it in writing now and handle it under the firm's complaints procedure; the full reply is due within eight weeks and names the Legal Ombudsman.", gate: 'none', severity: 'warning' });
  } else if (e.event === 'withhold_from_lender') {
    out.push({ kind: 'lender_approval', title: `${e.party} asks us not to tell the lender something`, detail: 'We act for the lender too and must report what affects its security or the offer (Lenders\' Handbook). If the client will not agree to it being reported, we must stop acting for the lender (and usually for the client on this purchase).', gate: ex, severity: 'critical' });
  } else if (e.event === 'gift_withdrawn') {
    out.push({ kind: 'completion_funds_shortfall', title: `${e.party}'s gift is withdrawn`, detail: `${exchanged ? 'After exchange the client is bound to complete: find replacement money now, or a notice to complete and the deposit are at stake.' : 'Plan the money again before exchange.'} Any new source needs its own proof of funds; tell the lender (the deposit it was told about has changed).`, gate: ex, severity: exchanged ? 'critical' : 'warning' });
  } else if (e.event === 'uncontactable') {
    out.push({ kind: 'transaction_at_risk', title: `Cannot reach ${e.party}`, detail: 'Try every contact on file and the agent; write to the address on file. Do nothing that needs their instructions (exchange, signing, money) until they respond; tell the other side if dates are at risk.', gate: ex, severity: 'warning' });
  } else if (e.event === 'moving_firm') {
    out.push({ kind: 'other', title: `${e.party} is moving to another firm`, detail: "Get their written authority to transfer the file, the new firm's details, and settle the bill; hand over the file and any money on account to the new firm; tell the other side and the lender; release any undertakings given or get the new firm to take them on.", gate: 'none', severity: 'warning' });
  } else if (e.event === 'ceasing_to_act') {
    out.push({ kind: 'other', title: `Ceasing to act for ${e.party}`, detail: 'Give the client reasonable notice in writing with the reason (unless it is an AML matter: then say nothing about why); tell the other side and the lender; deal with money on account and undertakings; keep the file.', gate: 'none', severity: 'warning' });
  } else {
    out.push({ kind: 'bankruptcy_insolvency', title: `${e.party} is bankrupt`, detail: ours ? (side === 'seller' ? 'The property vests in the trustee in bankruptcy, who is now the seller: the trustee\'s consent and signature, and the proceeds go to the trustee. Our money on account is frozen.' : 'Property a bankrupt acquires vests in the trustee, and dispositions after the petition are void: do not exchange or complete without the trustee\'s position in writing. Money on account is frozen.') : (side === 'buyer' ? 'The seller\'s trustee in bankruptcy is now the seller: deal with the trustee, check their appointment, and that they can give vacant possession.' : 'The buyer\'s trustee may complete or disclaim the contract: tell the client and await the trustee.'), gate, severity: 'critical' });
    lender('is bankrupt');
  }
  return out;
}

/** Every client has died: nothing more is sent to them. */
export const clientMessagesStopped = (s: MatterState): string | null => {
  const names = s.partyNames ?? [];
  const dead = new Set((s.partyEvents ?? []).filter((p) => p.event === 'died').map((p) => p.party.trim().toLowerCase()));
  return names.length && names.every((n) => dead.has(n.trim().toLowerCase())) ? `${names.join(' and ')} ${names.length === 1 ? 'has' : 'have'} died: nothing is sent to the client.` : null;
};

/** The notice period after a DAML request: seven working days (POCA 2002 s.335). */
export const damlNoticeEnds = (from: Date): string => addWorkingDays(from, 7, EW_CALENDAR).toISOString();
/** The moratorium after a refusal: 31 days (POCA 2002 s.335(6)). */
export const damlMoratoriumEnds = (from: Date): string => new Date(from.getTime() + 31 * 86_400_000).toISOString();

/** A consent request is pending, or refused and inside the moratorium: no money moves and nothing exchanges. */
export function amlHoldActive(s: MatterState, now: Date): boolean {
  const h = s.amlHold;
  if (!h) return false;
  if (h.status === 'granted') return false;
  if (h.status === 'awaiting') return now.getTime() < Date.parse(h.noticeEnds); // no reply in the notice period: consent is deemed
  return !!h.moratoriumEnds && now.getTime() < Date.parse(h.moratoriumEnds);
}

export const SANCTIONS_PREFIX = 'Sanctions match';
/** An uncleared sanctions match: a hard stop on money, exchange and completion that no gate change releases. */
export const sanctionsHold = (s: MatterState): boolean => Object.values(s.issues).some((i) => i.kind === 'aml_kyc_problem' && i.title.startsWith(SANCTIONS_PREFIX) && (i.status === 'open' || i.status === 'negotiating'));
