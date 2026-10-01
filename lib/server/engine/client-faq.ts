/**
 * Help for the client (docs/spec/ui.md "Client portal: Help"), organised by the workflow's macro stages, the same
 * steps the client sees in Progress: Instruction, Investigation, Enquiries, Contract & Exchange, Completion,
 * Registration (a remortgage or transfer: Instruction, Investigation, Completion, Registration).
 *
 * Every stage answers the same things in plain words, for the client's side: what happens in it, how long it usually
 * takes, and (at their current stage, from the case) what they need to do. Then the one or two questions clients ask
 * at that point. Their current stage comes first; the others follow in order, then the general ones.
 * General information about conveyancing in England and Wales: never advice, never an issue.
 */
import { MACRO_LABEL, macroStagesFor, type ClientPortalView, type MacroStage } from './client-portal';

export interface Faq { id: string; q: string; a: string }
export interface HelpSection { stage: MacroStage | 'general'; label: string; current: boolean; faqs: Faq[] }
type Side = ClientPortalView['side'];
interface StageGuide { what: string; howLong: string; more?: Array<{ id: string; q: string; a: string | ((v: ClientPortalView) => string) }> }

const day = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }) : null);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

const PAY_SAFELY = 'Call us on the number you already have before you send any money, and send a small test payment first if you can. We will never change our bank details by email.';

/** What each stage is, how long it takes, and what clients ask in it: by side. */
const GUIDE: Record<Side, Partial<Record<MacroStage, StageGuide>>> = {
  buyer: {
    instruction: {
      what: "We open your file, check your identity and where the money for the purchase is coming from, and ask the seller's solicitor for the contract papers.",
      howLong: 'Usually one to two weeks. The sooner we have your ID and proof of funds, the sooner we move on.',
      more: [
        { id: 'id_pof', q: 'Why do you need my ID and proof of funds?', a: 'The law (the Money Laundering Regulations) requires us to check who you are and where the money comes from, including any gifts. It is the same for every client.' },
        { id: 'survey', q: 'Should I get a survey?', a: "We recommend one. A lender's valuation only tells the lender the property is worth the loan. A RICS Level 2 or 3 survey tells you about its condition. Book it now so it is back before exchange." },
      ],
    },
    investigation: {
      what: "We order the searches, read the contract papers and the legal title, and check your mortgage offer. Anything unclear becomes a question for the seller's solicitor.",
      howLong: 'Usually three to six weeks. The council search is often the slowest part.',
      more: [
        { id: 'searches', q: 'What are searches?', a: 'Questions to the local council, the water company and others about the property: planning, roads, drainage, flooding and the environment.' },
        { id: 'mortgage', q: 'When will my mortgage offer arrive?', a: 'Usually two to four weeks after your lender has the valuation. Your lender sends it to us too; tell your broker if it is taking longer.' },
      ],
    },
    enquiries: {
      what: "We send the seller's solicitor our questions about anything the papers, title or searches leave unclear, and check every answer.",
      howLong: "Usually two to six weeks, depending on how quickly the seller's side replies. We follow them up for you.",
      more: [
        { id: 'enquiries', q: 'What kind of questions do you ask?', a: 'Things like missing guarantees or certificates, boundaries, rights of way, work done to the property, and anything the searches turned up.' },
      ],
    },
    contract: {
      what: 'We send you our report on title and the contract to sign, ask for your deposit, and agree a completion date with the other side. Then we exchange contracts.',
      howLong: 'Usually one to two weeks, once everyone in the chain is ready.',
      more: [
        { id: 'exchange', q: 'What does exchanging contracts mean?', a: 'The purchase becomes legally binding and the completion date is fixed. From then on, pulling out means losing your deposit. We only exchange with your go-ahead.' },
        { id: 'deposit', q: 'How do I pay the deposit?', a: `We ask you for it before exchange, usually 10% of the price. ${PAY_SAFELY}` },
        { id: 'insurance', q: 'Do I need buildings insurance?', a: (v) => (v.leasehold ? 'For a flat or other leasehold, the building is usually insured by the landlord; we check this. Arrange contents insurance from completion.' : 'Yes, from exchange: the property is at your risk from that point. Send us the policy schedule.') },
      ],
    },
    completion: {
      what: "We get the mortgage money from your lender and the balance from you, then send it all to the seller's solicitor on completion day. Once they have it, the property is yours.",
      howLong: 'Completion is on the date agreed at exchange, usually one to four weeks after it.',
      more: [
        { id: 'keys', q: 'When do I get the keys?', a: 'On completion day, usually by early afternoon, once the money has arrived. The estate agent hands them over.' },
        { id: 'balance', q: 'How do I send the rest of the money?', a: `We send you a completion statement showing exactly what is needed, a few working days before completion. ${PAY_SAFELY}` },
      ],
    },
    registration: {
      what: "We pay the Stamp Duty, then register you as the owner (and your lender's mortgage) at the Land Registry.",
      howLong: 'Usually a few weeks, sometimes a few months when the Land Registry is busy. You do not need to do anything.',
      more: [
        { id: 'deeds', q: 'Where are my title deeds?', a: 'Title deeds are now electronic: the Land Registry holds the official record. We send you a copy once you are registered.' },
      ],
    },
  },
  seller: {
    instruction: {
      what: 'We open your file, check your identity, get your title from the Land Registry, and ask you for the property forms.',
      howLong: 'Usually one to two weeks. Returning the forms promptly is the biggest help.',
      more: [
        { id: 'forms', q: 'What are the property forms?', a: (v) => `The Property Information Form (TA6) and the Fittings and Contents Form (TA10)${v.leasehold ? ', and the Leasehold Information Form (TA7)' : ''}. Answer as fully as you can; "not known" is fine where you genuinely do not know.` },
        { id: 'paperwork', q: 'What paperwork should I find?', a: 'Anything about work on the property: planning permissions, building regulations certificates, guarantees and warranties, and the boiler service record. Upload what you have under Documents.' },
      ],
    },
    investigation: {
      what: "We prepare the contract papers (the draft contract, your title and your forms) and send them to the buyer's solicitor, who starts their searches and checks.",
      howLong: "Usually one to three weeks for us; the buyer's searches and mortgage can take three to six weeks more.",
    },
    enquiries: {
      what: "The buyer's solicitor sends questions about the property and the papers. We answer most of them and ask you where only you know.",
      howLong: 'Usually two to six weeks. Quick answers from you keep the sale moving.',
    },
    contract: {
      what: 'We send you the contract to sign, get a figure from your lender to pay off your mortgage, and agree a completion date. Then we exchange contracts.',
      howLong: 'Usually one to two weeks, once everyone in the chain is ready.',
      more: [
        { id: 'exchange', q: 'What does exchanging contracts mean?', a: 'The sale becomes legally binding on you and the buyer, and the completion date is fixed. We only exchange with your go-ahead.' },
      ],
    },
    completion: {
      what: "On completion day the buyer's money arrives, we tell the estate agent to release the keys, pay off your mortgage and the agent, and send you the rest.",
      howLong: 'Completion is on the date agreed at exchange, usually one to four weeks after it.',
      more: [
        { id: 'move_out', q: 'When do I need to move out?', a: 'By the completion time on completion day (usually around lunchtime), leaving behind what the Fittings and Contents Form says stays, and the keys with the estate agent.' },
        { id: 'sale_money', q: 'When do I get my money?', a: 'On completion day, after your mortgage, the estate agent and our bill are paid, to the bank account you confirmed to us in writing at the start.' },
      ],
    },
    registration: {
      what: 'We confirm to your old lender and the Land Registry that the mortgage is paid off, so the buyer can be registered.',
      howLong: 'Usually a few weeks. You do not need to do anything.',
    },
  },
  owner: {
    instruction: {
      what: "We open your file, check your identity, and get your new lender's instructions.",
      howLong: 'Usually about a week.',
    },
    investigation: {
      what: 'We check your title, get a figure from your current lender to pay off the old mortgage, and prepare the new mortgage deed for you to sign.',
      howLong: 'Usually two to four weeks, mostly waiting for the lenders.',
      more: [
        { id: 'sign', q: 'What do I need to sign?', a: 'The new mortgage deed, in front of a witness who is not a family member. We send it with clear instructions.' },
      ],
    },
    completion: {
      what: 'Your new lender sends the money, we pay off your old mortgage, and send you anything left over.',
      howLong: 'On a date we agree once the new offer and the redemption figure are in. There is nothing for you to do on the day.',
    },
    registration: {
      what: 'We register the new mortgage at the Land Registry and remove the old one.',
      howLong: 'Usually a few weeks. You do not need to do anything.',
    },
  },
};

const GENERAL: Faq[] = [
  { id: 'pay_safely', q: 'How do I send you money safely?', a: `${PAY_SAFELY} If an email says our details have changed, do not pay and call us.` },
  { id: 'cost', q: 'What will it cost?', a: 'Our fees and the costs we pay for you (searches, Land Registry, any tax) are in the client care letter we sent at the start. If anything changes, we tell you first.' },
  { id: 'upload', q: 'How do I send you a document?', a: 'Use Send Us A Document under Documents, or the button on the task it is for. Clear photos from your phone are fine.' },
  { id: 'secure', q: 'Is this page secure?', a: 'It opens only with a code we email to you, and stays signed in on this device for 7 days. If you think someone else has the link, tell us and we will send a new one.' },
  { id: 'details', q: 'How do I update my contact details?', a: 'Send us a message below with your new details.' },
  { id: 'complaint', q: 'How do I raise a concern?', a: 'Tell your conveyancer first; most things are sorted quickly. Our complaints procedure is in the client care letter, and if we cannot put it right within eight weeks you can go to the Legal Ombudsman.' },
];

/** What they need to do now, from the case. */
function yourPart(v: ClientPortalView): string {
  return v.tasks.length ? `${list(v.tasks.map((t) => t.title))}: each is under For You, with the button to do it.` : 'Nothing right now. When we need something, it appears under For You and we email you.';
}

/** How long, with the case's own dates where it has them. */
function howLong(v: ClientPortalView, stage: MacroStage, generic: string): string {
  if (stage !== v.stage) return generic;
  const dated = stage === 'completion' && v.dates.completion ? `Your completion date is ${day(v.dates.completion)}.` : stage === 'contract' && v.dates.targetExchange ? `We are aiming to exchange by ${day(v.dates.targetExchange)}.` : v.dates.targetCompletion && stage !== 'registration' ? `We are aiming to complete by ${day(v.dates.targetCompletion)}.` : '';
  return [dated, generic].filter(Boolean).join(' ');
}

/** Help for this client: their current stage first, then the others in order, then the general questions. */
export function clientHelp(v: ClientPortalView): HelpSection[] {
  const guide = GUIDE[v.side];
  const stages = macroStagesFor(v.side).filter((s) => guide[s]);
  const at = Math.max(0, stages.indexOf(v.stage));
  const order = [...stages.slice(at), ...stages.slice(0, at)];
  const sections: HelpSection[] = order.map((stage) => {
    const g = guide[stage]!;
    const label = MACRO_LABEL[stage];
    const current = stage === v.stage && !v.closed;
    return {
      stage,
      label,
      current,
      faqs: [
        { id: `${stage}:what`, q: `What happens at ${label}?`, a: g.what },
        { id: `${stage}:how_long`, q: `How long does ${label} take?`, a: howLong(v, stage, g.howLong) },
        ...(current ? [{ id: `${stage}:you`, q: 'What do I need to do?', a: yourPart(v) }] : []),
        ...(g.more ?? []).map((m) => ({ id: `${stage}:${m.id}`, q: m.q, a: typeof m.a === 'function' ? m.a(v) : m.a })),
      ],
    };
  });
  return [...sections, { stage: 'general', label: 'General', current: false, faqs: GENERAL }];
}
