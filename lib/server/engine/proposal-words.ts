/**
 * What a proposal does, in words, written once per kind: the task's title for a chase ("Chase the client for their ID")
 * and the brief at the top of an opened proposal (what it does, to whom, with the facts that matter). The message
 * itself is shown beneath the brief, so the brief never repeats it; it says what the message is for and where things stand.
 */
import type { EngineEvent, MatterState } from './types';
import { profileOf } from './transactions';
import { SIGNED_DOCUMENT_LABEL } from './types';

const SEARCH_NAME: Record<string, string> = { LLC1: 'LLC1', CON29: 'CON29', DRAINAGE_WATER: 'drainage and water', ENVIRONMENTAL: 'environmental', CHANCEL: 'chancel', MINING: 'coal mining', FLOOD: 'flood risk', HIGHWAYS: 'highways', PLANNING: 'planning history' };
const gbp = (p: unknown) => (typeof p === 'number' && p > 0 ? `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 })}` : null);
const day = (iso: unknown) => (typeof iso === 'string' && iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** An enquiry raised from an issue is keyed ISS-10-E1; the other side knows it as E1. */
export const enquiryRef = (id: string) => id.replace(/^ISS-\d+-/, '');
const ENQUIRY_ON: Record<string, string> = { SEARCH: 'the search', TITLE: 'the title', MORTGAGE: 'the mortgage offer', CONTRACT: 'the draft contract', ID_CHECK: 'the ID', LEASE: 'the lease', MANAGEMENT_PACK: 'the management pack', PROOF_OF_FUNDS: 'the source of funds', REQUISITION: 'the requisition' };
/** An enquiry as a sentence names it: "enquiry E1", "follow-up 2 to enquiry E1", "our enquiry on the title" (a follow-up raised from a review, keyed TITLE-F1). */
export function enquiryName(id: string): string {
  const ref = enquiryRef(id);
  const f = /^(.+)-F(\d+)$/.exec(ref);
  if (!f) return `enquiry ${ref}`;
  const on = ENQUIRY_ON[f[1]] ?? (SEARCH_NAME[f[1]] ? `the ${SEARCH_NAME[f[1]]} search` : null);
  if (on) return `our enquiry on ${on}${f[2] === '1' ? '' : ` (${f[2]})`}`;
  return `follow-up ${f[2]} to enquiry ${enquiryRef(f[1])}`;
}

/** Who a role is, as a sentence says it. The engine's 'seller_solicitor' is the other side's solicitor: acting for the seller, the buyer's. */
export function whoIs(role: unknown, s: MatterState): string {
  const side = profileOf(s.transactionType).side;
  const r = side === 'seller' && role === 'seller_solicitor' ? 'buyer_solicitor' : String(role ?? 'client');
  return ({ client: 'the client', seller_solicitor: "the seller's solicitor", buyer_solicitor: "the buyer's solicitor", lender: 'the lender', estate_agent: 'the estate agent', search_provider: 'the search provider', hmlr: 'HM Land Registry', family: "the client's family", managing_agent: 'the managing agent', landlord: 'the landlord' } as Record<string, string>)[r] ?? 'the other side';
}

/** A party key ("donor:sandbox-donor-two") as the person it names, when the case knows them. */
function partyName(s: MatterState, subject: string | null | undefined): string | null {
  if (!subject || !subject.includes(':')) return null;
  const pc = s.partyChecks?.[subject];
  return pc?.label?.replace(/\s*\(.*$/, '') ?? subject.split(':')[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** What a chase asks for, said as the thing ("their ID", "the CON29 search", "replies to enquiry E2"). */
export function chaseFor(key: string, subject: string | null | undefined, s: MatterState): string {
  const sub = subject && !/^[0-9a-f-]{20,}$/i.test(subject) ? subject : null;
  switch (key) {
    case 'id_check': return 'their ID';
    case 'search': return `the ${sub ? `${SEARCH_NAME[sub] ?? sub.replace(/_/g, ' ').toLowerCase()} ` : ''}search result`;
    case 'enquiry': return sub ? `their reply to ${enquiryName(sub)}` : 'replies to our enquiries';
    case 'funds': return sub === 'lender' ? 'the mortgage advance' : 'the completion money';
    case 'registration': return 'the registration';
    case 'proof_of_funds': return 'the proof-of-funds form';
    case 'management_pack': return 'the management pack';
    case 'property_forms': return 'the property forms';
    case 'redemption': return 'the redemption statement';
    case 'lender_consent': return 'their consent';
    case 'discharge': return 'the discharge of the mortgage';
    case 'seller_discharge': return "the discharge of the seller's mortgage (DS1)";
    case 'retention_release': return 'release of the retention';
    case 'contract_pack': return 'the draft contract pack';
    case 'transfer_deed': return 'the signed transfer (TR1)';
    case 'signed_documents': return 'the signed documents';
    case 'mortgage_offer': return 'news of the mortgage offer';
    case 'survey': return 'whether they are having a survey';
    case 'deposit': return 'the deposit';
    case 'client_decision': return sub === 'exchange_authority' ? 'authority to exchange' : sub ? `their answer on ${sub.replace(/_/g, ' ')}` : 'their answer';
    case 'insurance': return 'the buildings insurance schedule';
    default: return sub ? sub.replace(/_/g, ' ') : 'what is outstanding';
  }
}

/** "Chase the client for their ID (asked 1 Sept, chased once)", "Ask the client whether they are having a survey (asked 3 Sept)". */
export function chaseTitle(key: string, recipientRole: unknown, subject: string | null | undefined, s: MatterState): string {
  const person = key === 'id_check' ? partyName(s, subject) : null;
  const who = person ?? whoIs(recipientRole ?? 'client', s);
  const w = s.waits.find((x) => !x.closedAt && x.key === key && (!subject || x.subject === subject));
  const k = w?.chasesSentAt.length ?? 0;
  const short = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const tail = w ? ` (asked ${short(w.openedAt)}${k ? `, chased ${k === 1 ? 'once' : k === 2 ? 'twice' : `${k} times`}` : ''})` : '';
  if (key === 'survey' || key === 'mortgage_offer') return `Ask ${who} ${key === 'survey' ? 'whether they are having a survey' : 'how the mortgage offer is going'}${tail}`;
  if (key === 'registration') return `Chase ${who} on the registration${tail}`;
  return `Chase ${who} for ${chaseFor(key, subject, s)}${tail}`;
}

const REQUEST_SAYS: Record<string, (c: Record<string, unknown>, s: MatterState) => string> = {
  request_contract_pack: (c) => (typeof c.leaseholdForms === 'string' && c.leaseholdForms.trim() ? `the draft contract, the official copies, the seller's property forms${c.leaseholdForms}` : "the draft contract, the official copies and the seller's property forms"),
  request_management_pack: () => 'the leasehold management pack (LPE1): service charge accounts and budget, ground rent, insurance and any major works',
  request_redemption_statement: (c) => `a redemption statement${str(c.completionDate) ? ` to completion on ${day(c.completionDate)}` : ''}, so the completion statement can show what pays off the mortgage`,
  request_lender_consent: (_c, s) => `their consent${s.transactionType === 'transfer_of_equity' ? ' to the transfer of equity, and confirmation of who stays on the mortgage' : ''}`,
  request_discharge: (c) => `confirmation that the mortgage${gbp((c.payload as Record<string, unknown> | undefined)?.amountPennies) ? ` of ${gbp((c.payload as Record<string, unknown>).amountPennies)}` : ''} is discharged (DS1 or e-DS1), so the register can be cleared`,
  request_signed_transfer: (c) => `the transfer (TR1) signed by the seller, to be held to our order${str(c.completionDate) ? ` for completion on ${day(c.completionDate)}` : ' until completion'}`,
};

const CLIENT_SAYS: Record<string, (c: Record<string, unknown>, s: MatterState) => string> = {
  progress_update: (c) => `Tells the client ${str(c.doneLine) ? `“${String(c.doneLine).replace(/\.?$/, '.')}”` : `that the ${str(c.done) ?? 'last step'} is done.`} Then where everything else stands and what happens next.`,
  searches_ordered: (c) => `Tells the client the searches are ordered${Array.isArray(c.searches) && c.searches.length ? ` (${list((c.searches as string[]).map((x) => SEARCH_NAME[x] ?? x))})` : ''}.`,
  searches_all_back: (c) => `Tells the client every search is back and reviewed${Array.isArray(c.searches) && c.searches.length ? ` (${list((c.searches as string[]).map((x) => SEARCH_NAME[x] ?? x))})` : ''}.`,
  search_back_all_clear: () => 'Tells the client a search is back with nothing of concern.',
  search_back_under_review: () => 'Tells the client a search is back and we are looking into what it shows.',
  enquiries_raised: (c) => { const o = ((c.payload as Record<string, unknown> | undefined)?.origin ?? {}) as Record<string, unknown>; return `Tells the client we have raised enquiries with the other side${str(o.about) ? ` about ${o.about}` : ''}, and that we will report the replies.`; },
  mortgage_offer_checked: () => 'Tells the client the mortgage offer is checked and what its conditions ask of them.',
  report_on_title_sent: () => 'Tells the client the report on title has gone to them, to read before they sign the contract.',
  exchanged: (c) => { const d = day((c.payload as Record<string, unknown> | undefined)?.completionDate ?? c.completionDate); return `Tells the client contracts are exchanged: the deal is now binding${d ? `, with completion on ${d}` : ''}.`; },
  completed: () => 'Tells the client completion has happened.',
  registration_complete: (c) => `Tells the client the registration at HM Land Registry is complete${(c.payload as Record<string, unknown> | undefined)?.lenderTold ? ' and the lender has been told' : ''}.`,
  completion_statement: (c) => `Sends the client the completion statement${gbp((c.payload as Record<string, unknown> | undefined)?.balancePennies) ? `, showing ${gbp((c.payload as Record<string, unknown>).balancePennies)} to pay` : ''}, as a secure link.`,
  deposit_request: (c) => `Asks the client for the deposit${typeof c.depositAmount === 'string' ? c.depositAmount : ''}, with our bank details. Exchange cannot happen until it is in as cleared funds.`,
  balance_request: (c) => { const a = gbp((c.payload as Record<string, unknown> | undefined)?.amountPennies); return `Asks the client for the balance of the completion money${a ? ` (${a})` : ''}${str(c.completionDate) ? ` before completion on ${day(c.completionDate)}` : ''}, with our verified bank details.`; },
  exchange_authority_request: (c) => `Asks the client to authorise exchange${typeof c.completionLine === 'string' ? c.completionLine.replace(/(\d{4}-\d{2}-\d{2})/, (d) => day(d) ?? d) : ''}. We cannot exchange without it.`,
  buildings_insurance_request: (_c, s) => (profileOf(s.transactionType).hasExchange ? `Asks the client for their buildings insurance schedule: the property is theirs to insure from exchange${s.hasLender ? ', and the lender needs to see it' : ''}.` : 'Asks the client for their buildings insurance schedule: the new lender needs to see the property is insured before the remortgage completes.'),
  property_forms_request: (c) => { const f = (c.payload as Record<string, unknown> | undefined)?.forms; return `Sends the client the property forms to fill in${Array.isArray(f) && f.length ? ` (${list(f as string[])})` : ''}.`; },
  ownership_basis_request: () => 'Asks the clients how they will own the property: as joint tenants or as tenants in common.',
  file_copy: (c) => `Sends the client a copy of ${str(c.what) ?? 'the file'}.`,
  email_reply: () => "A reply to the client's email.",
};

/** The event that prompted a proposal, as a person would say it. */
const PROMPTED_BY: Record<string, string> = {
  contract_pack_requested: 'the case left instruction', management_pack_requested: 'the case entered pre-contract', stage_advanced: 'the case moved stage',
  search_ordered: 'the searches were ordered', search_reviewed: 'the last search was reviewed', search_cleared: 'a search came back clear', contracts_exchanged: 'contracts were exchanged',
  completion_confirmed: 'completion was confirmed', register_checked: 'the register was checked', report_on_title_sent: 'the report on title was sent', mortgage_offer_cleared: 'the mortgage offer was checked',
  completion_statement_generated: 'the completion statement was drawn up', funds_requested: 'the funds request was approved', contract_approved: 'the contract was approved',
  enquiry_raised: 'enquiries were raised', property_forms_requested: 'the property forms were asked for', mortgage_redeemed: 'the mortgage was redeemed', signed_transfer_requested: 'the transfer was asked for',
  redemption_statement_requested: 'the redemption statement was asked for', lender_consent_requested: "the lender's consent was asked for", party_event_recorded: 'an event was recorded on the case',
  enquiry_reply_received: 'replies arrived', decision_resolved: 'a review was signed off',
};

export interface ProposalBrief { headline: string; rows: Array<[string, string | null, boolean?]> }

/** The brief at the top of an opened proposal. */
export function proposalBrief(input: { s: MatterState; action: string; detail: Record<string, unknown>; events: EngineEvent[]; summary: string; names: { counterpartySolicitor?: string | null; lender?: string | null; agent?: string | null; clients?: string[] } }): ProposalBrief {
  const { s, action, detail: det, events, names } = input;
  const ctx = (det.context ?? {}) as Record<string, unknown>;
  const role = det.recipientRole ?? det.to ?? (action === 'client_update' ? 'client' : action === 'enquiry_draft' ? 'seller_solicitor' : null);
  const who = whoIs(role, s);
  const named = role === 'seller_solicitor' || role === 'buyer_solicitor' ? names.counterpartySolicitor : role === 'lender' ? names.lender : role === 'estate_agent' ? names.agent : role === 'client' || action === 'client_update' ? (names.clients?.length ? list(names.clients) : null) : null;
  const toRow: [string, string | null] = ['To', `${who.replace(/^./, (c) => c.toUpperCase())}${named ? ` (${named})` : ''}`];
  const trig = typeof det.triggeredByEventId === 'string' ? events.find((e) => e.id === det.triggeredByEventId) : null;
  const tp = (trig?.payload ?? {}) as Record<string, unknown>;
  const prompted = !trig ? null : trig.type === 'party_event_recorded' ? `${str(tp.party) ?? 'a party'}: ${String(tp.event ?? 'an event').replace(/_/g, ' ')}, recorded` : PROMPTED_BY[trig.type] ?? trig.type.replace(/_/g, ' ');
  const because: [string, string | null] = ['Because', prompted ? `${prompted.replace(/^./, (c) => c.toUpperCase())} (${day(trig!.createdAt)})` : null];
  const firstSentence = (t: unknown) => { const b = str(t)?.replace(/^(Dear [^\n]*\n+)/, '').trim() ?? ''; const m = /^([\s\S]+?[.!?])(\s|$)/.exec(b); return (m ? m[1] : b.slice(0, 200)).replace(/\s+/g, ' '); };

  // A letter written for an event (a death, a withdrawal): its first sentence is what it says.
  if (det.letter || det.kind === 'party_message' || det.milestone === 'client_died') {
    return { headline: `A letter to ${who}${named ? ` (${named})` : ''}: “${firstSentence(det.body ?? (det.edited as Record<string, unknown> | undefined)?.body)}”`, rows: [toRow, ['Subject', str(det.subject) ?? str((det.edited as Record<string, unknown> | undefined)?.subject)], because] };
  }
  switch (action) {
    case 'chase': {
      if (det.kind === 'request') {
        const t = String(det.template ?? '');
        if (t === 'exchanged_agent') return { headline: `Tells the estate agent${named ? ` (${named})` : ''} that contracts are exchanged${str(ctx.completionDate) ? ` and completion is on ${day(ctx.completionDate)}` : ''}, so they can plan the keys.`, rows: [toRow, because] };
        if (t === 'completed_agent') return { headline: `Tells the estate agent${named ? ` (${named})` : ''} that completion has happened, so the keys can be released.`, rows: [toRow, because] };
        if (t === 'enquiries_to_seller_solicitor') return { headline: `Sends our enquiries to ${who}${named ? ` (${named})` : ''}.`, rows: [toRow, because] };
        const says = REQUEST_SAYS[t]?.(ctx, s) ?? t.replace(/^request_/, '').replace(/_/g, ' ');
        return { headline: `Asks ${who}${named ? ` (${named})` : ''} for ${says}. Once it goes we wait for it, and chase if it does not come.`, rows: [toRow, because] };
      }
      const key = String(det.waitKey ?? '');
      const w = s.waits.find((x) => !x.closedAt && x.key === key && (!det.subject || x.subject === det.subject));
      const chased = w?.chasesSentAt.length ?? 0;
      const what = chaseFor(key, str(det.subject), s);
      const person = key === 'id_check' ? partyName(s, str(det.subject)) : null;
      const target = person ?? `${who}${named ? ` (${named})` : ''}`;
      const since = w ? day(w.openedAt) : null;
      const last = w && chased ? day(w.chasesSentAt[chased - 1]) : null;
      return {
        headline: `We asked ${target} for ${what}${since ? ` on ${since}` : ''} and have had nothing back${chased ? `; chased ${chased === 1 ? 'once' : `${chased} times`} already, last on ${last}` : ''}. This ${chased ? `is chase ${chased + 1}` : 'is the first chase'}${role === 'client' ? ': it repeats what we need and re-sends their links and forms' : ': it repeats what we asked for and when'}.`,
        rows: [toRow, ['Asked for', what.replace(/^./, (c) => c.toUpperCase())], ['First asked', since], ['Chased', chased ? `${chased}× (last ${last})` : 'Not yet', chased >= 2]],
      };
    }
    case 'acknowledgement': {
      const ev = typeof det.forEventId === 'string' ? events.find((e) => e.id === det.forEventId) : null;
      const thing = (str(det.what) ?? 'what they sent').replace(/^your\s+/i, 'their ').replace(/\bproof of funds form\b/i, 'proof-of-funds form');
      return { headline: `A short note to ${who}${named ? ` (${named})` : ''} to say ${thing} arrived${ev ? ` on ${day(ev.createdAt)}` : ''}. The note says nothing about the contents: those wait for the review.`, rows: [toRow] };
    }
    case 'counterparty_update': {
      const what = str(det.title) ?? firstSentence(det.body);
      return { headline: `Tells ${who}${named ? ` (${named})` : ''} where our side stands: ${what.replace(/^./, (c) => c.toLowerCase()).replace(/\.$/, '')}.`, rows: [toRow, because] };
    }
    case 'search_order': {
      const st = String(det.searchType ?? '');
      const name = SEARCH_NAME[st] ?? st.replace(/_/g, ' ').toLowerCase();
      const why = /Why: ([^\n]+)/.exec(input.summary)?.[1] ?? null;
      const provider = str(det.provider);
      return { headline: `Orders the ${name}${/search/i.test(name) ? '' : ' search'} from ${!provider || /^mock|stub/i.test(provider) ? 'the search provider' : provider === 'infotrack' ? 'InfoTrack' : provider}. The fee is charged to the firm and goes on the client's bill as a disbursement.`, rows: [['Search', name.replace(/^./, (c) => c.toUpperCase())], ['Why', why ? why.replace(/\.$/, '').replace(/^./, (c) => c.toUpperCase()) : null]] };
    }
    case 'enquiry_draft': {
      const body = str(det.subject) ?? '';
      const items = [...body.matchAll(/^\s*\d+\.\s+(.+)$/gm)].map((m) => m[1].split(/ — |: /)[0].trim());
      const k = items.length || 1;
      const issue = typeof det.issueId === 'string' ? s.issues[det.issueId] : null;
      return {
        headline: `${k} ${k === 1 ? 'enquiry' : 'enquiries'} to ${who}${named ? ` (${named})` : ''}${str(det.about) ? ` arising from ${det.about}` : ''}. Read each one and edit or remove any before they go; the replies come back to the case to review.`,
        rows: [toRow, ['Enquiries', items.length ? items.slice(0, 6).map((x, i) => `${i + 1}. ${x.length > 90 ? `${x.slice(0, 88)}…` : x}`).join('\n') : null], ['From the issue', issue ? issue.title : null]],
      };
    }
    case 'client_update': {
      const kind = String(det.kind ?? '');
      if (kind === 'id_check_request') {
        const label = str(det.label);
        return { headline: `Sends ${label && !/^the client$/i.test(label) ? label : 'the client'} a link to verify their identity online${str(det.provider) === 'infotrack' ? ' (InfoTrack)' : ''}: their photo ID and a selfie. The result comes back to the case.`, rows: [['To', label ?? toRow[1]]] };
      }
      if (kind === 'proof_of_funds_request') {
        return det.followUpOf
          ? { headline: `Asks the client for more evidence of where their money comes from${str(det.noteToClient) ? `: ${String(det.noteToClient).replace(/\.$/, '')}` : ''}. The form goes with it, so they can add statements.`, rows: [toRow] }
          : { headline: 'Sends the client the proof-of-funds form: how much they are putting in, where each amount comes from, and the statements that show it.', rows: [toRow] };
      }
      if (kind === 'signing_pack') {
        const docs = Array.isArray(det.documents) ? (det.documents as string[]).map((d) => ((SIGNED_DOCUMENT_LABEL as Record<string, string>)[d] ?? d.replace(/_/g, ' ')).replace(/^./, (c) => c.toLowerCase())) : [];
        return { headline: `Sends the client ${docs.length ? `the ${list(docs)}` : 'the documents'} to sign, with how to sign ${docs.length === 1 ? 'it' : 'each one'}.`, rows: [toRow] };
      }
      if (kind === 'survey_advice') return { headline: 'Sends the client your advice on the survey: what the surveyor found and what it means for the purchase.', rows: [toRow] };
      const tpl = String(det.template ?? '');
      const says = CLIENT_SAYS[tpl]?.(ctx, s) ?? `Updates the client: ${tpl.replace(/_/g, ' ')}.`;
      return { headline: says, rows: [toRow, because] };
    }
    default:
      return { headline: input.summary.split('\n').find((l) => l.trim() && !/^[A-Z' —-]+$/.test(l.trim())) ?? action.replace(/_/g, ' '), rows: [toRow] };
  }
}

/** What a rules' clear cleared, from the decision's subject: "the reply to our enquiry on the title", "the CON29 search", "the mortgage offer from Halifax". */
export function clearedThing(subject: string | null | undefined): string {
  const x = (subject ?? '').trim();
  if (!x) return 'the document';
  if (/^(?:ISS-\d+-)?E\d+(?:-F\d+)?$|^[A-Z0-9_]+-F\d+$/.test(x)) return `the reply to ${enquiryName(x)}`;
  if (SEARCH_NAME[x]) return `the ${SEARCH_NAME[x]} search`;
  const mo = /^Mortgage offer(?: \((.+)\))?$/i.exec(x);
  if (mo) return `the mortgage offer${mo[1] ? ` from ${mo[1]}` : ''}`;
  const t = /^Title (\S+)$/.exec(x);
  if (t) return `the official copies of ${t[1]}`;
  const id = /^ID\/AML check(?: — (.*?))?(?: \([^)]*\))?$/.exec(x);
  if (id) return `the ID / AML check${id[1] ? ` for ${id[1]}` : ''}`;
  return /^[A-Z]{2}/.test(x) ? x : `the ${x.charAt(0).toLowerCase()}${x.slice(1)}`;
}
