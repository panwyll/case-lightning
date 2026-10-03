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

export type PartyEvent = 'died' | 'capacity_lost' | 'bankrupt' | 'instructing_for_client' | 'confidence' | 'refuses_to_sign' | 'capacity_doubt' | 'cdd_refused' | 'complaint' | 'withhold_from_lender' | 'gift_withdrawn' | 'uncontactable' | 'moving_firm' | 'ceasing_to_act' | 'donor_died' | 'gift_donor_died' | 'company_insolvent' | 'sanctions_designated' | 'contributions_changed' | 'fee_dispute' | 'third_party_payment' | 'cash_paid_in';
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
    // What follows is done, not described: the notices are drafted for approval (deathPlaybook) and the case closes or waits for the estate.
    const how = deathCase(s, e.party, side);
    if (how === 'other_side') out.push({ kind: 'probate_issue', title: `${e.party} (the other side) has died: waiting for their personal representatives`, detail: exchanged ? 'The contract binds their estate; the personal representatives complete once they have the grant. Ask the other side for the expected timing and agree a new date.' : 'Nothing can be signed on their side until the grant. Ask the other side for the expected timing; the client decides whether to wait.', gate, severity: 'critical' });
    else if (how === 'await_grant') out.push({ kind: 'probate_issue', title: `Waiting for the grant: ${e.party}'s personal representatives take over`, detail: 'Nothing goes to the client now. When the grant is issued: see it, identify the personal representatives (ID and AML), record them as the clients, and agree the dates with the other side.', gate, severity: 'critical' });
    else if (how === 'survivor') out.push({ kind: 'client_change', title: `${e.party} has died: does ${(s.partyNames ?? []).filter((n) => n.trim().toLowerCase() !== e.party.trim().toLowerCase()).join(' and ')} go ahead?`, detail: side === 'seller' ? `Joint tenants (no Form A restriction, no severance): the survivor sells alone with the death certificate; the contract${exchanged ? ' binds the estate and the transfer is' : ' and transfer are'} redrawn with the survivor as seller. Tenants in common (a Form A restriction): the survivor appoints a second trustee to receive the money, or the personal representatives join after the grant (LPA 1925 s.27). Unregistered: the survivor's statutory declaration (Law of Property (Joint Tenants) Act 1964). Then record the clients now on the case.` : exchanged ? 'The contract binds the estate with the surviving client: take their instructions, then record the clients now on the case.' : 'Take the surviving client\'s instructions when they are ready. Going ahead: record the clients now on the case (the funding, the lender and the SDLT are redone). Not: close the case.', gate, severity: 'critical' });
  } else if (e.event === 'capacity_lost') {
    if (e.hasAttorney) out.push({ kind: 'power_of_attorney_issue', title: `${e.party} has lost capacity: instructions from the attorney`, detail: 'See the registered lasting power of attorney and check it covers property; identify the attorney as a client; they sign in the donor\'s name. A trustee co-owner needs the attorney to have a beneficial interest too (TDA 1999 s.1), or a replacement trustee.', gate, severity: 'critical' });
    else out.push({ kind: 'power_of_attorney_issue', title: `${e.party} has lost capacity and there is no power of attorney`, detail: `No one can give instructions or sign for ${e.party} until the Court of Protection appoints a deputy (usually months).${ours && !sole && side === 'seller' ? ' As a co-owner they are also a trustee of the land: a replacement trustee is appointed (TDA 1999 s.20 direction, or the Court of Protection under s.36(9) Trustee Act 1925) before the sale can complete.' : ''} ${exchanged ? 'The contract binds: tell the other side at once and plan for a delayed completion.' : 'Do not exchange; tell the other side and re-plan the dates, or abandon if the delay is unacceptable.'}`, gate, severity: 'critical' });
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
  } else if (e.event === 'donor_died') {
    out.push({ kind: 'probate_issue', title: `${e.party}, who gave the power of attorney, has died`, detail: `The power ended on the death: the attorney may not sign or instruct for them any more. The personal representatives take over on the grant of probate or letters of administration. ${exchanged ? 'The contract binds the estate: tell the other side, and re-plan completion around the grant.' : 'Do not exchange; tell the other side and re-plan the dates.'}`, gate, severity: 'critical' });
  } else if (e.event === 'gift_donor_died') {
    out.push({ kind: 'completion_funds_shortfall', title: `${e.party}, who was giving money, has died`, detail: `A gift not yet paid over is now part of ${e.party}'s estate: only the personal representatives can pay it, after the grant. Ask the client how the money will be found; reopen the proof of funds for any new source; tell the lender (the deposit it was told about has changed). A gift already paid may be relevant to inheritance tax (seven years), not to this purchase.`, gate: ex, severity: exchanged ? 'critical' : 'warning' });
  } else if (e.event === 'company_insolvent') {
    out.push({ kind: 'bankruptcy_insolvency', title: `${e.party} is in liquidation or struck off`, detail: `Check Companies House now. In liquidation: only the liquidator can sell or complete (see their appointment; they give no warranties). Struck off: its property passes to the Crown as bona vacantia, and only the Crown (Bona Vacantia Division / the Duchies) can deal with it until the company is restored. ${exchanged ? 'Completion cannot happen as planned: tell the client and the other side.' : 'Do not exchange.'}`, gate, severity: 'critical' });
  } else if (e.event === 'sanctions_designated') {
    out.push({ kind: 'aml_kyc_problem', title: `${SANCTIONS_PREFIX}: ${e.party} designated during the matter`, detail: 'A designated person\'s funds and economic resources are frozen (SAMLA 2018). Stop at once: no money in or out, no exchange, no completion, no work that benefits them. Report to OFSI; nothing further without an OFSI licence. Do not tell the client a report is made.', gate, severity: 'critical' });
  } else if (e.event === 'fee_dispute') {
    out.push({ kind: 'complaint', title: `${e.party} disputes the bill`, detail: "Fees come out of the client's money only after a bill has been sent and the client has agreed (or not objected) to its deduction. Hold back only the disputed amount and pay the rest on as normal; handle the dispute under the complaints procedure (the client can ask the court to assess the bill, Solicitors Act 1974 s.70).", gate: 'none', severity: 'warning' });
  } else if (e.event === 'third_party_payment') {
    out.push({ kind: 'aml_kyc_problem', title: `${e.party} asks us to pay someone else from the money`, detail: 'We pay out only what belongs to the transaction (the seller, the lender, the agent\'s fee, SDLT, the registry). A payment to a builder, a relative or anyone else is a banking service the SRA Accounts Rules forbid (rule 3.3): pay the balance to the client\'s own account and let them pay it on. A request to pay a third party is also a money-laundering red flag.', gate: 'none', severity: 'warning' });
  } else if (e.event === 'cash_paid_in') {
    out.push({ kind: 'aml_kyc_problem', title: `${e.party} paid cash in, or wants to`, detail: "The firm's policy: no cash into client account (above the small limit it sets). Refuse it; if it has been paid in, do not pay it out to anyone but the person who paid it, after the MLRO has considered it. Ask where the cash came from and record the answer; consider whether a report is needed (and say nothing to the client about one).", gate: ex, severity: 'critical' });
  } else if (e.event === 'contributions_changed') {
    out.push({ kind: 'co_ownership_advice', title: `${e.party}: the money each buyer puts in has changed`, detail: 'Work out the shares again and advise both buyers, separately if their interests differ: joint tenants own equally whatever they paid; tenants in common hold the shares in a declaration of trust (fixed shares, by contribution, or a floating formula). Update the declaration of trust before exchange, and the proof of funds if a source changed.', gate: ex, severity: 'warning' });
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

// ── What happens next, not only what it means (a death: the people told, tactfully; the case closed or handed on) ──

export type PlaybookParty = 'seller_solicitor' | 'estate_agent' | 'lender' | 'client' | 'family';
export interface PlaybookMessage { key: string; to: PlaybookParty; subject: string; body: string }

/** Whose death it is and what follows, from the case (deathPlaybook and due.ts read the same). */
export function deathCase(s: MatterState, party: string, side: 'buyer' | 'seller' | 'owner'): 'close' | 'await_grant' | 'survivor' | 'other_side' {
  const names = (s.partyNames ?? []).map((n) => n.trim().toLowerCase());
  const ours = names.includes(party.trim().toLowerCase());
  if (!ours) return 'other_side';
  if (names.length > 1) return 'survivor';
  return side === 'buyer' && !s.exchange.exchangedAt ? 'close' : 'await_grant';
}

/**
 * The letters a death calls for, worded with care (each is a draft a person approves before it goes). A sole client buying
 * before exchange: the purchase ends, the other side, the agent and the lender are told, and a letter of condolence goes
 * to the family with what happens to the money we hold. Otherwise the transaction carries on through the personal
 * representatives (or the surviving client), and everyone is told what that means for the timetable.
 */
export function deathPlaybook(s: MatterState, party: string, side: 'buyer' | 'seller' | 'owner', property: string): PlaybookMessage[] {
  const how = deathCase(s, party, side);
  const exchanged = !!s.exchange.exchangedAt;
  const deal = side === 'seller' ? 'sale' : side === 'owner' ? 'transaction' : 'purchase';
  const out: PlaybookMessage[] = [];
  const subject = `${property}: ${how === 'other_side' ? `the death of ${party}` : `our client, ${party}`}`;
  if (how === 'other_side') {
    out.push({ key: 'client', to: 'client', subject: `${property}: sad news from the other side`, body: `We are sorry to tell you that ${party} has died. ${exchanged ? `The contract still stands: their personal representatives take over, but they cannot sign until the grant of probate (or letters of administration) is issued, so completion will be later than planned. We will agree a new date with the other side and keep you informed.` : `Nothing can be signed on their side until their personal representatives have the grant of probate (or letters of administration), which usually takes some months. We will ask the other side's solicitor for their expected timing and let you know, so you can decide how you would like to proceed.`}` });
    return out;
  }
  if (how === 'close') {
    out.push({ key: 'seller_solicitor', to: 'seller_solicitor', subject, body: `We are very sorry to let you know that our client, ${party}, has died. The purchase of ${property} will not now go ahead, and we are closing our file. Please pass this on to your client with our apologies for the disappointment this will cause.` });
    out.push({ key: 'estate_agent', to: 'estate_agent', subject, body: `We are very sorry to let you know that our client, ${party}, has died, and the purchase of ${property} will not now go ahead. We have told the seller's solicitor.` });
    if (s.hasLender) out.push({ key: 'lender', to: 'lender', subject, body: `We write to tell you that your applicant, ${party}, has died. The purchase of ${property} will not proceed and the mortgage offer will not be needed; please close your file. We hold none of your funds.` });
    out.push({ key: 'family', to: 'family', subject: `${party}`, body: `We were so sorry to hear of ${party}'s death, and we send our sincere condolences to you and the family.\n\nThere is nothing you need to do about the purchase of ${property}: we have told the seller's side that it will not go ahead, and we are closing our file. ${s.deposit.received || Object.keys(s.money?.received ?? {}).length ? `We hold money on account for ${party}. It now belongs to their estate, and we will return it to their personal representatives once we have seen the grant of probate (or letters of administration); there is no hurry.` : 'We hold no money for them.'}\n\nIf it would help to talk anything through, please call us at any time.` });
    return out;
  }
  if (how === 'survivor') {
    const left = (s.partyNames ?? []).filter((n) => n.trim().toLowerCase() !== party.trim().toLowerCase());
    out.push({ key: 'seller_solicitor', to: 'seller_solicitor', subject, body: `We are very sorry to tell you that our client, ${party}, has died. ${exchanged ? `The contract binds their estate with ${left.join(' and ')}; we will be in touch about completion, which may need to move.` : `We are taking ${left.join(' and ')}'s instructions on whether to go ahead and will be in touch shortly; please bear with us.`}` });
    if (s.hasLender && side !== 'seller') out.push({ key: 'lender', to: 'lender', subject, body: `We write to tell you that one of your borrowers, ${party}, has died. ${left.join(' and ')} wishes to consider going ahead; please let us know whether the offer can stand in their name alone, or what you need. We will not draw down funds until we hear from you.` });
    out.push({ key: 'family', to: 'family', subject: `${party}`, body: `We were so sorry to hear of ${party}'s death, and we send our sincere condolences.\n\nThere is no rush on anything to do with ${property}. When you feel ready, we will talk through with ${left.join(' and ')} whether to carry on with the ${deal}, and what that would involve.` });
    return out;
  }
  // A sole client, but the transaction goes on: a sale (the estate sells), or a purchase already exchanged (the estate is bound).
  out.push({ key: 'seller_solicitor', to: 'seller_solicitor', subject, body: `We are very sorry to tell you that our client, ${party}, has died. ${exchanged ? `The contract binds their estate, and their personal representatives will complete once they have the grant of probate (or letters of administration).` : `The ${deal} can go ahead once their personal representatives have the grant of probate (or letters of administration).`} We will let you know the expected timing as soon as we can; please pass this on to your client.` });
  out.push({ key: 'estate_agent', to: 'estate_agent', subject, body: `We are very sorry to tell you that our client, ${party}, has died. The ${deal} of ${property} will be delayed while the estate is dealt with; we will keep you informed.` });
  if (s.hasLender && side !== 'seller') out.push({ key: 'lender', to: 'lender', subject, body: `We write to tell you that your borrower, ${party}, has died after exchange of contracts on ${property}. Please let us know what you need from us; we will not draw down funds without your written instructions.` });
  out.push({ key: 'family', to: 'family', subject: `${party}`, body: `We were so sorry to hear of ${party}'s death, and we send our sincere condolences.\n\nThe ${deal} of ${property} ${exchanged ? 'was already agreed and will go ahead' : 'can still go ahead'} through ${party}'s personal representatives (the executors named in the will, or the next of kin if there is no will). Nothing needs to be done straight away. When you are ready, please let us know who the personal representatives are and send us the grant of probate (or letters of administration) once it is issued; we will take it from there.` });
  return out;
}
