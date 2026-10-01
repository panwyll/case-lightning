/**
 * Answers to what clients ask (docs/spec/ui.md "Client portal: Help"). The questions clients actually ask at their
 * stage come first, for their side (buying, selling, remortgaging): at the start it is "what happens first", near
 * exchange "how do I pay the deposit", after exchange "when do I get the keys". Every other answer sits below,
 * searchable, by topic.
 *
 * Written to reassure and to say what happens next, never to invite a complaint: "What's happening now?", not
 * "Why haven't I heard?". Where the case can answer, the answer is the case's own (what is done, what is next, the
 * dates). General information about conveyancing in England and Wales; never advice, never an issue.
 */
import type { ClientPortalView } from './client-portal';

export type FaqTopic = 'Getting Started' | 'Your Part' | 'Money' | 'Exchange And Completion' | 'After Completion' | 'This Page';
export interface Faq { id: string; topic: FaqTopic; q: string; a: string }
type Side = ClientPortalView['side'];
type Stage = 'start' | 'progress' | 'exchange' | 'exchanged' | 'completed';
interface FaqSpec { id: string; topic: FaqTopic; q: string | ((v: ClientPortalView) => string); a: string | ((v: ClientPortalView) => string); sides?: Side[]; when?: (v: ClientPortalView) => boolean; /** The stages where it is one of the first things asked, in the order to show them. */ asked?: Partial<Record<Stage, number>> }

const day = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }) : null);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const deal = (v: ClientPortalView) => (v.side === 'buyer' ? 'purchase' : v.side === 'seller' ? 'sale' : v.transaction.toLowerCase().includes('transfer') ? 'transfer' : 'remortgage');

/** Where the client is, in the five moments that change what they ask. */
export function stageOf(v: ClientPortalView): Stage {
  switch (v.lifecycle) {
    case 'instructed': return 'start';
    case 'pre_exchange': case 'investigating': return 'progress';
    case 'ready_to_exchange': case 'ready_to_complete': return 'exchange';
    case 'exchanged': case 'pre_completion': return 'exchanged';
    default: return 'completed';
  }
}

/** "What's happening now?": what is done, what we are doing or expecting next, and anything we need from them. */
function happeningNow(v: ClientPortalView): string {
  const done = v.progress.filter((p) => p.state === 'done').map((p) => p.label.toLowerCase());
  const next = v.waitingOnOthers.flatMap((w) => w.what.map((what) => `${what} from ${w.who}`));
  const mine = v.tasks.map((t) => t.title.toLowerCase());
  return [
    `Where we are: ${v.stageLabel}.`,
    done.length ? `Done so far: ${list(done)}.` : '',
    next.length ? `Next, we are expecting ${list(next)}, and we follow it up for you.` : 'We are working on the next step.',
    mine.length ? `We also need your ${list(mine)}: see For You.` : '',
  ].filter(Boolean).join(' ');
}

const target = (v: ClientPortalView) =>
  v.dates.completion ? `Completion is fixed for ${day(v.dates.completion)}.` : v.dates.targetCompletion ? `We are aiming to complete by ${day(v.dates.targetCompletion)}.` : v.dates.targetExchange ? `We are aiming to exchange by ${day(v.dates.targetExchange)}.` : '';

const FAQS: FaqSpec[] = [
  // ── Getting started ──
  { id: 'now', topic: 'Getting Started', q: (v) => `What's happening on my ${deal(v)} now?`, a: happeningNow, asked: { start: 1, progress: 1, exchange: 1 } },
  { id: 'first', topic: 'Getting Started', sides: ['buyer'], q: 'What happens first?', asked: { start: 2 },
    a: "We check your identity and where the money is coming from, order the searches on the property, and ask the seller's solicitor for the contract papers. Once those arrive we go through everything and raise any questions with the seller's side." },
  { id: 'first_sale', topic: 'Getting Started', sides: ['seller'], q: 'What happens first?', asked: { start: 2 },
    a: "We check your identity, get the title from the Land Registry, and ask you for the property forms. With those we prepare the contract papers and send them to the buyer's solicitor." },
  { id: 'first_owner', topic: 'Getting Started', sides: ['owner'], q: (v) => `How does a ${deal(v)} work?`, asked: { start: 2, progress: 2 },
    a: (v) => (deal(v) === 'transfer' ? 'We check everyone\'s identity, get your lender\'s consent if there is a mortgage, prepare the transfer for everyone to sign, and register the change at the Land Registry.' : 'We check your identity, get the new lender\'s instructions and a redemption figure from your current lender, and check the title. On completion the new lender sends the money, we pay off the old mortgage, and register the new one.') },
  { id: 'todo', topic: 'Your Part', q: 'Is there anything I need to do?', asked: { start: 3, progress: 2, exchange: 4, exchanged: 4 },
    a: (v) => (v.tasks.length ? `Yes: ${list(v.tasks.map((t) => t.title.toLowerCase()))}. Each is under For You, with the button to do it.` : 'Nothing right now. When we need something, it appears under For You and we email you.') },
  { id: 'how_long', topic: 'Getting Started', q: (v) => `How long will my ${deal(v)} take?`, asked: { start: 4, progress: 4 },
    a: (v) => [target(v), v.side === 'owner' ? 'A remortgage usually takes four to eight weeks.' : 'In England and Wales a sale or purchase takes about four months on average from instruction to completion, longer with a chain, a leasehold or a new build.'].filter(Boolean).join(' ') },
  { id: 'id_pof', topic: 'Your Part', sides: ['buyer'], q: 'Why do you need my ID and proof of funds?', asked: { start: 5 },
    a: 'The Money Laundering Regulations require us to check who you are and where the money for a purchase comes from, including any gifts. It is the same for every client, and we keep what you send securely.' },
  { id: 'id', topic: 'Your Part', sides: ['seller', 'owner'], q: 'Why do you need my ID?', asked: { start: 5 },
    a: 'The Money Laundering Regulations require us to check who you are before we act for you. It also protects you against someone pretending to own your property.' },
  { id: 'survey', topic: 'Your Part', sides: ['buyer'], q: 'Should I get a survey?', asked: { start: 6, progress: 6 },
    a: "Yes, we recommend one. A lender's valuation is not a survey: it tells the lender the property is worth the loan, not what condition it is in. A RICS Level 2 or Level 3 survey tells you about the building. Book it early, and send us the report." },
  { id: 'forms', topic: 'Your Part', sides: ['seller'], q: 'What are the property forms?', asked: { start: 3, progress: 5 },
    a: (v) => `The Property Information Form (TA6) and the Fittings and Contents Form (TA10)${v.leasehold ? ', and the Leasehold Information Form (TA7)' : ''}. Answer as fully as you can; "not known" is fine where you genuinely do not know.` },
  { id: 'paperwork', topic: 'Your Part', sides: ['seller'], q: 'What paperwork should I find?', asked: { start: 4 },
    a: 'Anything about work on the property: planning permissions, building regulations certificates, guarantees and warranties (windows, damp, roof), the boiler service record and the gas safety certificate. Upload what you have under Documents.' },

  // ── In progress ──
  { id: 'searches', topic: 'Getting Started', sides: ['buyer'], q: 'What are searches?', asked: { progress: 3 },
    a: 'Searches ask the local council, the water company and others about the property: planning, roads, drainage, flooding and environmental risks. Most come back within one to three weeks; the council search can take longer depending on the council.' },
  { id: 'enquiries', topic: 'Getting Started', sides: ['buyer'], q: 'What are enquiries?', asked: { progress: 5 },
    a: "Questions we send the seller's solicitor about anything the contract papers, the title or the searches leave unclear. We go through the answers before we recommend exchanging." },
  { id: 'enquiries_sale', topic: 'Your Part', sides: ['seller'], q: "What are the buyer's enquiries?", asked: { progress: 3 },
    a: "Questions from the buyer's solicitor about the property or the paperwork. We answer most of them; where only you know the answer, we ask you. Quick answers keep the sale moving." },
  { id: 'when_exchange', topic: 'Exchange And Completion', sides: ['buyer', 'seller'], q: 'When will we exchange?', asked: { progress: 4, exchange: 2 },
    a: (v) => (v.dates.targetExchange ? `We are aiming to exchange by ${day(v.dates.targetExchange)}.` : 'When everything is in place on both sides and everyone in the chain is ready.') + ' Exchange needs the searches and enquiries finished, the mortgage offer in (if there is one), signed contracts and, for a buyer, the deposit.' },
  { id: 'removals', topic: 'Exchange And Completion', sides: ['buyer', 'seller'], q: 'Can I book removals?', asked: { progress: 7, exchange: 5 },
    a: 'You can get quotes now and pencil in a date, but only confirm it once we have exchanged: the completion date is only fixed at exchange.' },

  // ── Ready to exchange ──
  { id: 'exchange', topic: 'Exchange And Completion', sides: ['buyer', 'seller'], q: 'What happens at exchange?', asked: { exchange: 1 },
    a: (v) => `The contracts become binding and the completion date is fixed. ${v.side === 'buyer' ? 'You pay the deposit (usually 10%), and from then on pulling out means losing it. ' : 'From then on the sale is binding on you and the buyer. '}We only exchange with your go-ahead.` },
  { id: 'deposit', topic: 'Money', sides: ['buyer'], q: 'How do I pay the deposit?', asked: { exchange: 2 },
    a: 'We ask you for it before exchange. Call us on the number you already have before you send it, to confirm our bank details, and send a small test payment first if you can. We will never change our bank details by email.' },
  { id: 'insurance', topic: 'Exchange And Completion', sides: ['buyer'], q: 'Do I need buildings insurance?', asked: { exchange: 5 },
    a: (v) => (v.leasehold ? 'For a flat or other leasehold, the building is usually insured by the landlord or management company; we check this for you. You will still want contents insurance from completion.' : 'Yes, from exchange: the property is at your risk from that point, and your lender will require it. Upload the schedule under Documents.') },
  { id: 'rot', topic: 'Exchange And Completion', sides: ['buyer'], q: 'What is the report on title?', asked: { exchange: 3 },
    a: 'Our report on what we have found: the legal title, the searches, the replies to our enquiries and anything you should know before you commit. Read it, and send us any questions before we exchange.' },
  { id: 'redemption', topic: 'Money', sides: ['seller', 'owner'], q: 'How is my mortgage paid off?', asked: { exchange: 3 },
    a: 'We get the exact figure from your lender and pay it off on completion from the money that comes in. You do not need to do anything, but tell us about every loan secured on the property.' },
  { id: 'owner_completion', topic: 'Exchange And Completion', sides: ['owner'], q: 'What happens on completion?', asked: { exchange: 1 },
    a: 'Your new lender sends us the money, we pay off your old mortgage, and we send you anything left over. Then we register the new mortgage at the Land Registry. There is nothing for you to do on the day.' },

  // ── Exchanged ──
  { id: 'completion_day', topic: 'Exchange And Completion', sides: ['buyer', 'seller'], q: 'What happens on completion day?', asked: { exchanged: 1 },
    a: (v) => (v.side === 'buyer' ? `We send the money to the seller's solicitor in the morning. Once they confirm it has arrived, the purchase is complete and the estate agent releases the keys. ${v.dates.completion ? `Your completion date is ${day(v.dates.completion)}.` : ''}` : `The buyer's solicitor sends us the money. Once it arrives we tell the estate agent to release the keys, pay off your mortgage and send you the balance. ${v.dates.completion ? `Your completion date is ${day(v.dates.completion)}.` : ''}`).trim() },
  { id: 'keys', topic: 'Exchange And Completion', sides: ['buyer'], q: 'When do I get the keys?', asked: { exchanged: 2 },
    a: 'On completion day, once the seller\'s solicitor has the money, usually by early afternoon. The estate agent hands them over when we tell them it has completed.' },
  { id: 'balance', topic: 'Money', sides: ['buyer'], q: 'How do I send the rest of the money?', asked: { exchanged: 3 },
    a: 'We send you a completion statement showing exactly what is needed. It must reach us a few working days before completion. Call us to confirm our bank details before you send it: we never change them by email.' },
  { id: 'before_move', topic: 'Exchange And Completion', sides: ['buyer', 'seller'], q: 'What should I arrange before moving?', asked: { exchanged: 5 },
    a: (v) => (v.side === 'buyer' ? 'Removals, contents insurance from completion, and the utilities and council tax in your name from the completion date. Take meter readings when you arrive.' : 'Removals, meter readings on the day, and telling the utilities, council and your insurer the date you leave. Leave behind what the Fittings and Contents Form says stays.') },
  { id: 'move_out', topic: 'Exchange And Completion', sides: ['seller'], q: 'When do I need to move out?', asked: { exchanged: 2 },
    a: 'By the completion time on completion day (usually around lunchtime; the contract says), leaving the keys with the estate agent.' },
  { id: 'sale_money', topic: 'Money', sides: ['seller'], q: 'When do I get the money from my sale?', asked: { exchanged: 3, completed: 2 },
    a: 'On completion day, after we pay off your mortgage, the estate agent and our bill. We send the rest to the bank account you confirmed to us in writing at the start.' },
  { id: 'date_change', topic: 'Exchange And Completion', sides: ['buyer', 'seller'], q: 'Can the completion date change?', asked: { exchanged: 6 },
    a: 'Only if everyone in the chain agrees, because it is part of the binding contract. If you need to change it, tell us as soon as possible.' },

  // ── After completion ──
  { id: 'after', topic: 'After Completion', q: 'What happens now?', asked: { completed: 1 },
    a: (v) => (v.side === 'buyer' ? 'We pay the Stamp Duty and file the return, then register you as the owner at the Land Registry. You do not need to do anything.' : v.side === 'seller' ? 'We have paid off your mortgage and sent you the balance. We confirm to the Land Registry that the mortgage is repaid. Your completion statement is under Documents.' : 'We register the change at the Land Registry. You do not need to do anything.') },
  { id: 'registered', topic: 'After Completion', sides: ['buyer', 'owner'], q: 'When will the Land Registry update?', asked: { completed: 2 },
    a: 'Usually within a few weeks, sometimes a few months when the Land Registry is busy. We tell you when it is done and send you the updated title.' },
  { id: 'deeds', topic: 'After Completion', q: 'Where are my documents?', asked: { completed: 3 },
    a: 'Everything we have sent you is under Documents on this page. Title deeds are now electronic: the Land Registry holds the official record.' },

  // ── Any time ──
  { id: 'sdlt', topic: 'Money', sides: ['buyer'], q: 'What about Stamp Duty?', asked: { exchanged: 7 },
    a: 'Stamp Duty Land Tax (Land Transaction Tax in Wales) is due within 14 days of completion. We work it out, include it in the money we ask you for, and file and pay it for you.' },
  { id: 'pay_safely', topic: 'Money', q: 'How do I send you money safely?', a: 'Call us on the number you already have before you send anything, and send a small test payment first if you can. We will never change our bank details by email; if an email says we have, do not pay and call us.' },
  { id: 'cost', topic: 'Money', q: 'What will it cost?', a: 'Our fees and the costs we pay for you (searches, Land Registry, any tax) are set out in the client care letter we sent at the start. If anything changes, we tell you first.' },
  { id: 'mortgage_expiry', topic: 'Your Part', sides: ['buyer', 'owner'], when: (v) => v.hasLender, q: 'What if my mortgage offer is about to expire?', a: 'Tell your broker or lender early: most offers last about six months. We check the expiry against the completion date for you.' },
  { id: 'upload', topic: 'This Page', q: 'How do I send you a document?', a: 'Use Send Us A Document under Documents, or the button on the task it is for. Photos from your phone are fine as long as every page is clear.' },
  { id: 'secure', topic: 'This Page', q: 'Is this page secure?', a: 'It opens only with a code we email to you, and stays signed in on this device for 7 days. If you think someone else has the link, tell us and we will send you a new one.' },
  { id: 'details', topic: 'This Page', q: 'How do I update my contact details?', a: 'Send us a message below with your new details, and we will update them.' },
  { id: 'complaint', topic: 'This Page', q: 'How do I raise a concern?', a: "Tell your conveyancer first; most things are sorted quickly. Our complaints procedure is in the client care letter, and if we cannot put it right within eight weeks you can go to the Legal Ombudsman." },
];

export interface ClientHelp { now: Faq[]; all: Faq[] }

/** The questions for this client: the first ones asked at their stage, then every other one for their side, by topic. */
export function clientHelp(v: ClientPortalView): ClientHelp {
  const stage = stageOf(v);
  const fits = FAQS.filter((f) => (!f.sides || f.sides.includes(v.side)) && (!f.when || f.when(v)));
  const out = (f: FaqSpec): Faq => ({ id: f.id, topic: f.topic, q: typeof f.q === 'function' ? f.q(v) : f.q, a: typeof f.a === 'function' ? f.a(v) : f.a });
  const now = fits.filter((f) => f.asked?.[stage] != null).sort((a, b) => a.asked![stage]! - b.asked![stage]!).slice(0, 5);
  const ORDER: FaqTopic[] = ['Getting Started', 'Your Part', 'Exchange And Completion', 'Money', 'After Completion', 'This Page'];
  const rest = fits.filter((f) => !now.includes(f)).sort((a, b) => ORDER.indexOf(a.topic) - ORDER.indexOf(b.topic));
  return { now: now.map(out), all: rest.map(out) };
}
