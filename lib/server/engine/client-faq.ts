/**
 * Answers to what clients ask most (docs/spec/ui.md "Client portal: Help"), shown on the portal before
 * the way to contact us. General information about conveyancing in England and Wales, never advice
 * on the client's own position; where the case can answer it ("why haven't I heard?", "when will it
 * finish?"), the answer is the case's own. Questions for the client's side and stage come first.
 */
import type { ClientPortalView } from './client-portal';

export interface Faq { id: string; topic: 'Timing' | 'Money' | 'Your Part' | 'Exchange And Completion' | 'This Page'; q: string; a: string }
type Side = ClientPortalView['side'];
interface FaqSpec { id: string; topic: Faq['topic']; q: string; a: string | ((v: ClientPortalView) => string); sides?: Side[]; when?: (v: ClientPortalView) => boolean; /** Stages where it is most asked: shown first. */ hot?: string[] }

const day = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }) : null);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const PRE = ['instructed', 'pre_exchange', 'ready_to_exchange', 'investigating', 'ready_to_complete'];

const FAQS: FaqSpec[] = [
  {
    id: 'quiet', topic: 'Timing', q: "Why haven't I heard anything?", hot: PRE,
    a: (v) => {
      const others = v.waitingOnOthers.map((w) => `${w.who} (${list(w.what)})`);
      const mine = v.tasks.map((t) => t.title.toLowerCase());
      return [
        others.length ? `Right now we are waiting for ${list(others)}. We chase them for you and will be in touch as soon as anything changes.` : 'Nothing is held up with anyone else at the moment; we are working on the next step.',
        mine.length ? `We are also waiting for ${list(mine)} from you; see For You above.` : '',
        'Conveyancing has long quiet stretches while searches and the other side catch up. Quiet does not mean stuck.',
      ].filter(Boolean).join(' ');
    },
  },
  {
    id: 'how_long', topic: 'Timing', q: 'How long will it take?', hot: ['instructed', 'pre_exchange', 'investigating'],
    a: (v) => {
      const target = v.dates.completion ? `Completion is fixed for ${day(v.dates.completion)}.` : v.dates.targetCompletion ? `We are aiming to complete by ${day(v.dates.targetCompletion)}.` : v.dates.targetExchange ? `We are aiming to exchange by ${day(v.dates.targetExchange)}.` : '';
      const typical = v.side === 'owner' ? 'A remortgage usually takes four to eight weeks.' : 'In England and Wales a sale or purchase takes about four months on average from instruction to completion, longer with a chain, a leasehold or a new build.';
      return [target, typical, 'The slowest parts are usually the searches, the other side\'s replies to our questions, and everyone in the chain being ready on the same day.'].filter(Boolean).join(' ');
    },
  },
  { id: 'searches', topic: 'Timing', sides: ['buyer'], hot: ['instructed', 'pre_exchange'], q: 'What are searches and why do they take so long?', a: 'Searches ask the local council, the water company and others about the property: planning, roads, drainage, flooding and environmental risks. Most come back in one to three weeks; the local authority search can take longer, depending on the council.' },
  { id: 'enquiries', topic: 'Timing', sides: ['buyer'], hot: ['pre_exchange'], q: 'What are enquiries?', a: "Questions we send the seller's solicitor about anything the contract papers, the title or the searches leave unclear. We cannot recommend exchanging until the answers are satisfactory, and the seller's side often takes a while to reply." },
  { id: 'id_pof', topic: 'Your Part', sides: ['buyer'], q: 'Why do you need my ID and proof of where the money comes from?', hot: ['instructed'], a: 'The Money Laundering Regulations require us to check who you are and where the money for a purchase comes from, including any gifts. We cannot go ahead until the checks are done, and we keep what you send securely.' },
  { id: 'id', topic: 'Your Part', sides: ['seller', 'owner'], q: 'Why do you need my ID?', hot: ['instructed'], a: 'The Money Laundering Regulations require us to check who you are before we act for you, and it protects you against someone pretending to own your property. We keep what you send securely.' },
  { id: 'forms', topic: 'Your Part', sides: ['seller'], hot: ['instructed', 'pre_exchange'], q: 'What are the property forms?', a: (v) => `The Property Information Form (TA6) and the Fittings and Contents Form (TA10)${v.leasehold ? ', and the Leasehold Information Form (TA7)' : ''}. Answer as fully and accurately as you can: the buyer relies on them, and a wrong answer can be expensive later. If you are unsure, say so rather than guess.` },
  { id: 'survey', topic: 'Your Part', sides: ['buyer'], hot: ['instructed', 'pre_exchange'], q: 'Do I need a survey?', a: "A lender's valuation is not a survey: it tells the lender the property is worth the loan, not what condition it is in. A RICS Level 2 or Level 3 survey tells you about the building. Get it done before exchange, and tell us anything in it that worries you." },
  { id: 'rot', topic: 'Your Part', sides: ['buyer'], hot: ['pre_exchange', 'ready_to_exchange'], q: 'What is the report on title?', a: 'Our report on what we have found: the legal title, the searches, the replies to our enquiries and anything you should know before you commit. Read it carefully and send us your questions before we exchange.' },
  { id: 'mortgage_expiry', topic: 'Your Part', sides: ['buyer', 'owner'], when: (v) => v.hasLender, q: 'What if my mortgage offer is about to expire?', a: 'Tell your broker or lender as soon as you can: most offers last about six months, and an extension or a fresh offer can take time. We check the offer\'s expiry against the completion date.' },
  { id: 'exchange', topic: 'Exchange And Completion', sides: ['buyer', 'seller'], hot: ['pre_exchange', 'ready_to_exchange'], q: 'What happens at exchange?', a: (v) => `The contracts become binding and the completion date is fixed. ${v.side === 'buyer' ? 'You pay the deposit (usually 10%), and from then on pulling out means losing it and possibly more. ' : 'From then on the sale is binding on you and the buyer. '}We only exchange with your say-so.` },
  { id: 'insurance', topic: 'Exchange And Completion', sides: ['buyer'], hot: ['ready_to_exchange', 'exchanged'], q: 'When do I need buildings insurance?', a: (v) => (v.leasehold ? 'For a flat or other leasehold, the building is usually insured by the landlord or the management company; we check this. You will still want contents insurance from completion.' : 'From exchange: the property is at your risk from that point, and your lender will insist on it. Send us the schedule when you have it.') },
  { id: 'keys', topic: 'Exchange And Completion', sides: ['buyer'], hot: ['exchanged', 'pre_completion'], q: 'When do I get the keys?', a: "On completion day, once the seller's solicitor has received the money. That is usually by early afternoon; the estate agent releases the keys when we tell them it has completed." },
  { id: 'move_out', topic: 'Exchange And Completion', sides: ['seller'], hot: ['exchanged', 'pre_completion'], q: 'When do I need to move out?', a: 'By the completion time on completion day (usually around lunchtime; the contract says), leaving behind what the Fittings and Contents Form says stays, and leaving the keys with the estate agent.' },
  { id: 'sale_money', topic: 'Money', sides: ['seller'], hot: ['exchanged', 'pre_completion'], q: 'When do I get the money from my sale?', a: 'On completion day, after we pay off your mortgage, the estate agent and our bill. We send the balance to the bank account you confirmed to us in writing at the start, and we never change it on the strength of an email.' },
  { id: 'redemption', topic: 'Money', sides: ['seller', 'owner'], q: 'How is my mortgage paid off?', a: 'We ask your lender for a redemption statement and pay it off on completion from the money that comes in. You do not need to do anything, but tell us about every loan secured on the property.' },
  { id: 'sdlt', topic: 'Money', sides: ['buyer'], q: 'What about Stamp Duty?', a: "Stamp Duty Land Tax (Land Transaction Tax in Wales) is due within 14 days of completion. We work it out, include it in the money we ask you for before completion, file the return and pay it for you. GOV.UK has a calculator if you want to check the figure." },
  { id: 'pay_safely', topic: 'Money', q: 'How do I send you money safely?', a: 'Call us on the number you already have for us before you send anything, and send a small test payment first if you can. We will never change our bank details by email; if an email says we have, do not pay and call us. Fraudsters target property buyers.' },
  { id: 'cost', topic: 'Money', q: 'What will it cost?', a: 'Our fees and the costs we pay on your behalf (searches, Land Registry, any tax) are set out in the client care letter we sent at the start. If anything changes, we tell you before it does.' },
  { id: 'secure', topic: 'This Page', q: 'Is this page secure?', a: 'It opens only with a code we email to your address on the case, and stays signed in on this device for 7 days. Do not forward the link. If you think someone else has it, tell us and we will send you a new one.' },
  { id: 'upload', topic: 'This Page', q: 'How do I send you a document?', a: 'Use Send Us A Document under Documents, or the button on the task it is for. Photos from your phone are fine as long as every page is clear. Files up to 4 MB; email anything larger.' },
  { id: 'complaint', topic: 'This Page', q: 'How do I make a complaint?', a: "Tell your conveyancer, or ask for the firm's complaints procedure, which is in our client care letter. If we have not resolved it within eight weeks, or you are unhappy with our answer, you can go to the Legal Ombudsman." },
];

/** The questions for this client: their side's, with the ones most asked at their stage first. */
export function clientFaqs(v: ClientPortalView): Faq[] {
  const fits = FAQS.filter((f) => (!f.sides || f.sides.includes(v.side)) && (!f.when || f.when(v)));
  const hot = (f: FaqSpec) => (f.hot?.includes(v.lifecycle) ? 0 : 1);
  return fits
    .map((f, i) => ({ f, i }))
    .sort((a, b) => hot(a.f) - hot(b.f) || a.i - b.i)
    .map(({ f }) => ({ id: f.id, topic: f.topic, q: f.q, a: typeof f.a === 'function' ? f.a(v) : f.a }));
}
