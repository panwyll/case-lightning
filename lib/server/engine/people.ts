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

export type PartyEvent = 'died' | 'capacity_lost' | 'bankrupt';
export interface Consequence { kind: IssueKind; title: string; detail: string; gate: IssueGate; severity: IssueSeverity }

/** What a person's death, loss of capacity or bankruptcy means for this case, before or after exchange. */
export function partyEventConsequences(s: MatterState, e: { event: PartyEvent; party: string; hasAttorney: boolean | null }, side: 'buyer' | 'seller' | 'owner'): Consequence[] {
  const exchanged = !!s.exchange.exchangedAt;
  const gate: IssueGate = exchanged ? 'completion' : 'exchange';
  const ours = (s.partyNames ?? []).some((n) => n.trim().toLowerCase() === e.party.trim().toLowerCase());
  const sole = ours && (s.partyNames ?? []).length <= 1;
  const borrower = ours && s.hasLender && (side === 'buyer' || side === 'owner');
  const out: Consequence[] = [];
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
