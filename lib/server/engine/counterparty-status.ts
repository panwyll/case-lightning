/**
 * What the other side (their solicitor, the estate agent) may be told about our side of the
 * transaction (docs/spec/triggers.md "Updates to the other side"). A status reply to them, and a
 * milestone notice, is written ONLY from these facts, never from the client's own brief: the
 * disclosure is decided here, not left to a drafter leaving things out.
 *
 * Shared: the progress of the work (searches, enquiries, the contract, replies), that the mortgage
 * offer is in or awaited (status only, never its terms), whether we are ready to exchange and what
 * is outstanding with whom, and the target dates.
 * Never shared: the client's finances, gifts, source of funds, ID or AML results, the content of any
 * problem, negotiating positions, the client's reasons or circumstances. The client's own chain
 * (their sale or purchase) only when the client has said we may (`MatterState.shareChain`).
 */
import { caseBrief } from './brief';
import { profileOf } from './transactions';
import type { MatterState } from './types';

export interface CounterpartyStatus {
  /** Where our side stands, one plain sentence each. */
  lines: string[];
  /** What we are waiting for from them. */
  fromThem: string[];
  /** Nothing outstanding on our side for exchange. */
  readyToExchange: boolean;
}

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

export function counterpartyStatus(s: MatterState, now: Date, to: 'seller_solicitor' | 'estate_agent' = 'seller_solicitor'): CounterpartyStatus {
  const b = caseBrief(s, now);
  const side = profileOf(s.transactionType).side;
  const ws = Object.fromEntries(b.workstreams.map((w) => [w.id, w.status])) as Record<string, string>;
  const done = (id: string) => ws[id] === 'complete' || ws[id] === 'not_applicable' || ws[id] === undefined;
  const lines: string[] = [];
  const exchanged = !!s.exchange.exchangedAt;

  if (exchanged) {
    lines.push(`Contracts were exchanged on ${day(s.exchange.exchangedAt!)}${s.exchange.completionDate ? `, with completion on ${day(s.exchange.completionDate)}` : ''}.`);
  } else if (side === 'buyer') {
    if (ws.searches === 'complete') lines.push('Our searches are back.');
    else if (ws.searches === 'awaiting' || ws.searches === 'under_review') lines.push('Our searches are ordered and awaited.');
    else if (ws.searches === 'not_started') lines.push('Our searches are not yet ordered.');
    if (ws.enquiries === 'awaiting') lines.push('We have raised enquiries and are waiting for the replies.');
    else if (ws.enquiries === 'under_review') lines.push('We have the replies to our enquiries and are considering them.');
    else if (ws.enquiries === 'complete') lines.push('Our enquiries are dealt with.');
    if (s.hasLender) lines.push(done('mortgage') ? "Our client's mortgage offer is in." : "Our client's mortgage offer is not yet in.");
    // The survey's findings are the client's; only that it is done.
    if (ws.survey === 'complete') lines.push("Our client's survey is done.");
  } else if (side === 'seller') {
    if (s.contractPack.sentAt) lines.push(`We sent the contract pack on ${day(s.contractPack.sentAt)}.`);
    else lines.push('We are preparing the contract pack.');
    if (ws.enquiries === 'in_progress') lines.push('We are working on the replies to your enquiries.');
    else if (ws.enquiries === 'complete') lines.push('We have replied to all the enquiries raised.');
    if (ws.leasehold === 'complete') lines.push('We have the management pack.');
    else if (ws.leasehold === 'awaiting') lines.push('The management pack is requested and awaited.');
    if (ws.redemption === 'complete') lines.push('We have the redemption statement.');
    if (s.readiness.signedContractHeldAt) lines.push('We hold our client\'s signed contract.');
  }

  // The client's own chain: only on their say-so.
  if (s.shareChain && s.chainLinks?.length) lines.push(`Further along the chain: ${s.chainLinks.filter((l) => l.status === 'ready').length} of ${s.chainLinks.length} ready.`);
  if (s.shareChain && s.relatedMatter) lines.push(`Our client also has a linked ${s.relatedMatter.relation}; ${ws.chain === 'blocked' ? 'there is a delay further along the chain, which we are following up' : 'it is progressing'}.`);

  // Ready to exchange: nothing on our side outstanding (the client's checks are named only as "our side").
  const ours = side === 'buyer'
    ? ['searches', 'enquiries', 'mortgage', 'id_aml', 'source_of_funds', 'deposit', 'report_on_title', 'survey', 'co_ownership'].filter((id) => !done(id) && !(id === 'survey' && ws.survey === 'awaiting'))
    : ['property_forms', 'enquiries', 'leasehold', 'redemption', 'id_aml'].filter((id) => !done(id));
  const signed = !!s.readiness.signedContractHeldAt;
  const readyToExchange = !exchanged && ours.length === 0 && signed;
  if (!exchanged) {
    if (readyToExchange) lines.push('We are ready to exchange on our side.');
    else if (ours.length === 0 && !signed) lines.push("Everything on our side is done except our client's signature to the contract, which we are arranging.");
    else if (ours.some((id) => ['id_aml', 'source_of_funds', 'deposit', 'co_ownership', 'report_on_title'].includes(id))) lines.push('We are completing our own pre-exchange steps with our client.');
  }
  if (!exchanged && (s.targetExchangeDate || s.targetCompletionDate)) {
    lines.push(`We are working towards ${[s.targetExchangeDate ? `exchange by ${day(s.targetExchangeDate)}` : null, s.targetCompletionDate ? `completion around ${day(s.targetCompletionDate)}` : null].filter(Boolean).join(' and ')}.`);
  }

  // What is with them (their solicitor): the other side's outstanding items, by name.
  const fromThem = to === 'seller_solicitor' ? b.waiting.filter((w) => w.role === 'seller_solicitor').map((w) => w.what) : [];
  return { lines, fromThem, readyToExchange };
}

/** The facts for a drafter writing to the other side: only these, and what may not be said. */
export function renderCounterpartyFacts(s: MatterState, now: Date, to: 'seller_solicitor' | 'estate_agent'): string {
  const c = counterpartyStatus(s, now, to);
  const side = profileOf(s.transactionType).side;
  return [
    `WHAT WE MAY TELL THEM (we act for the ${side === 'seller' ? 'seller' : side === 'owner' ? 'owner' : 'buyer'}; these facts only, nothing else about our client):`,
    ...c.lines.map((l) => `- ${l}`),
    c.fromThem.length ? `WAITING FROM THEM: ${c.fromThem.join('; ')}.` : '',
    `NEVER SAY: anything about our client's finances, gifts, source of funds, ID or AML checks, the content of any problem or negotiation, or their reasons or circumstances${s.shareChain ? '' : "; nothing about our client's own sale or purchase (if asked, say we will take our client's instructions)"}. Do not promise dates beyond the targets above.`,
  ].filter(Boolean).join('\n');
}

/** Without a model: the status as a short email to the other side. */
export function templateCounterpartyUpdate(s: MatterState, now: Date, to: 'seller_solicitor' | 'estate_agent', property: string | null): string {
  const c = counterpartyStatus(s, now, to);
  const side = profileOf(s.transactionType).side === 'seller' ? 'seller' : 'buyer';
  const open = to === 'seller_solicitor' ? 'Dear Colleagues,' : 'Hello,';
  const P = [open, `We act for the ${side}${property ? ` in the matter of ${property}` : ''}. Where things stand on our side:`, c.lines.map((l) => `• ${l}`).join('\n')];
  if (c.fromThem.length) P.push(`We are waiting for ${c.fromThem.join(', ')} from you.`);
  return P.join('\n\n');
}

/**
 * Milestones the other side hears about without asking (so they chase less), each once per case
 * and recipient. Mortgage offer: status only, never its terms.
 */
export const COUNTERPARTY_MILESTONES = [
  { key: 'searches_back', side: 'buyer', to: ['seller_solicitor'], title: 'Our searches are back', when: (s: MatterState, c: CounterpartyStatus) => !s.exchange.exchangedAt && c.lines.includes('Our searches are back.') },
  { key: 'mortgage_offer', side: 'buyer', to: ['seller_solicitor', 'estate_agent'], title: "Our client's mortgage offer is in", when: (s: MatterState, c: CounterpartyStatus) => !s.exchange.exchangedAt && s.hasLender && c.lines.includes("Our client's mortgage offer is in.") },
  { key: 'ready_to_exchange', side: 'any', to: ['seller_solicitor', 'estate_agent'], title: 'We are ready to exchange', when: (_s: MatterState, c: CounterpartyStatus) => c.readyToExchange },
] as const;
export type CounterpartyMilestone = (typeof COUNTERPARTY_MILESTONES)[number]['key'];

/** The milestones due now that have not gone to that recipient yet (sent ones are keyed `cp_<milestone>:<to>`). */
export function dueCounterpartyNotices(s: MatterState, now: Date): Array<{ key: CounterpartyMilestone; to: 'seller_solicitor' | 'estate_agent'; title: string }> {
  if (!s.enrolled || s.abandoned || s.completion.confirmedAt) return [];
  const side = profileOf(s.transactionType).side;
  if (side === 'owner') return [];
  const out: Array<{ key: CounterpartyMilestone; to: 'seller_solicitor' | 'estate_agent'; title: string }> = [];
  for (const m of COUNTERPARTY_MILESTONES) {
    if (m.side !== 'any' && m.side !== side) continue;
    for (const to of m.to) {
      if (s.clientUpdateLastSentAt[`cp_${m.key}:${to}`]) continue;
      if (m.when(s, counterpartyStatus(s, now, to))) out.push({ key: m.key, to, title: m.title });
    }
  }
  return out;
}

/** The notice itself: the milestone first, then where our side stands. */
export function counterpartyNotice(s: MatterState, now: Date, n: { key: CounterpartyMilestone; to: 'seller_solicitor' | 'estate_agent'; title: string }, property: string | null): { subject: string; body: string } {
  const c = counterpartyStatus(s, now, n.to);
  const side = profileOf(s.transactionType).side === 'seller' ? 'seller' : 'buyer';
  const rest = c.lines.filter((l) => l.replace(/\.$/, '') !== n.title);
  const P = [n.to === 'seller_solicitor' ? 'Dear Colleagues,' : 'Hello,', `We act for the ${side}${property ? ` in the matter of ${property}` : ''}. ${n.title}.`];
  if (rest.length) P.push(rest.join(' '));
  if (c.fromThem.length) P.push(`We are waiting for ${c.fromThem.join(', ')} from you.`);
  return { subject: `${property ?? 'Our client\'s transaction'}: ${n.title.toLowerCase().replace(/^./, (x) => x.toUpperCase())}`, body: P.join('\n\n') };
}
