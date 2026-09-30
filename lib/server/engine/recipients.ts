/**
 * Who needs to hear when an email comes in (docs/spec/triggers.md). The writer always gets a
 * reply (anyone else, when they asked us something); beyond that, what the email says decides who else is written to in the same task: the
 * client reporting the deal at risk means the other side's solicitor is asked where their client
 * stands, and so on. A rule table, not a model: the drafter only words each message.
 * Nothing here sends anything. Each message is a draft on the task, ticked or offered, and goes
 * only when a person approves it.
 */
import type { NoteActionDraft } from './notes';
import type { MessageParty, NoteSender, SenderRelation } from './types';

/** The party a reply to the writer goes to. */
const REPLY_TO: Partial<Record<SenderRelation, MessageParty>> = { client: 'client', other_side: 'seller_solicitor', agent: 'estate_agent', lender: 'lender' };

export interface Recipient { to: MessageParty; purposes: string[]; on: boolean; /** The same, as sentences for the message when no drafter is available. */ sentences: string[] }

interface Rule {
  /** Who wrote. */
  from: SenderRelation[];
  /** What in the email (a line's command) sets it off. */
  when: (line: NoteActionDraft) => boolean;
  to: MessageParty;
  purpose: (line: NoteActionDraft) => string;
  /** The sentence the message says when there is no drafter to word it. */
  sentence: (line: NoteActionDraft) => string;
  /** Ticked when the task opens. */
  on: boolean;
}

const issue = (...kinds: string[]) => (l: NoteActionDraft) => l.command?.type === 'raise_issue' && kinds.includes(l.command.kind);

export const RECIPIENT_RULES: Rule[] = [
  // What an issue would otherwise send the writer on its own is asked in the reply instead (one email, not two).
  { from: ['client'], when: issue('survey_report_outstanding'), to: 'client', on: true, purpose: () => 'Ask them to send us the survey report', sentence: () => 'Please send us the survey report as soon as you have it.' },
  { from: ['client'], when: issue('mortgage_at_risk'), to: 'client', on: true, purpose: () => 'Ask what has changed with the mortgage, and say the lender must be told before exchange', sentence: () => 'Could you let us know exactly what has changed? Your lender must be told before we can exchange.' },
  // The deal at risk: the other side is asked, today, where their client stands and what they need.
  { from: ['client', 'agent'], when: issue('transaction_at_risk'), to: 'seller_solicitor', on: true, purpose: () => "Ask where their client stands and what timescale they need, and say where we are (no more of our client's position than that)", sentence: () => 'We understand your client may not proceed. Please confirm your client\'s position, and the timescale they need, as soon as possible.' },
  { from: ['client', 'agent'], when: issue('transaction_at_risk'), to: 'estate_agent', on: false, purpose: () => "Tell the agent what our client has told us, and that we have asked the other side's solicitor where their client stands", sentence: (l) => `Our client tells us: "${(l.command as { title?: string }).title ?? 'the other side may not proceed'}". We have asked the other side's solicitor to confirm their client's position and will let you know what they say.` },
  // A delay or a chain problem on their side: ask for their timescale.
  { from: ['client', 'agent'], when: issue('seller_delay', 'chain_dependency'), to: 'seller_solicitor', on: true, purpose: () => 'Ask for their timescale and where the chain stands', sentence: () => 'Please let us know your client\'s timescale and where the chain stands.' },
  // Dates the client wants: put them to the other side (a proposal, not an agreement).
  { from: ['client'], when: (l) => l.command?.type === 'set_target_dates', to: 'seller_solicitor', on: false, purpose: (l) => { const c = l.command as { targetExchangeDate?: string | null; targetCompletionDate?: string | null }; return `Propose the dates our client would like${c.targetExchangeDate ? `: exchange ${c.targetExchangeDate}` : ''}${c.targetCompletionDate ? `${c.targetExchangeDate ? ',' : ':'} completion ${c.targetCompletionDate}` : ''}, and ask whether their client can work to them`; }, sentence: (l) => { const c = l.command as { targetExchangeDate?: string | null; targetCompletionDate?: string | null }; return `Our client would like to ${[c.targetExchangeDate ? `exchange on ${c.targetExchangeDate}` : null, c.targetCompletionDate ? `complete on ${c.targetCompletionDate}` : null].filter(Boolean).join(' and ')}. Please let us know whether your client can work to this.`; } },
  // The mortgage in doubt: the lender or broker is asked to confirm where the offer stands.
  { from: ['client'], when: issue('mortgage_at_risk'), to: 'lender', on: false, purpose: () => 'Ask the lender or broker to confirm the status of the mortgage offer', sentence: () => 'Please confirm the current status of the mortgage offer.' },
];

/** An issue's own automatic follow-up, and who it goes to: when the task writes to that party it carries the follow-up instead (service.ts). */
export const FOLLOW_UP_PARTY: Record<string, MessageParty> = { transaction_at_risk: 'seller_solicitor', mortgage_at_risk: 'client', survey_report_outstanding: 'client' };

/** The messages an email's task should carry, one per party, the reply to the writer first. */
export function whoNeedsToHear(from: NoteSender | null, lines: NoteActionDraft[]): Recipient[] {
  const out = new Map<MessageParty, Recipient>();
  const reply = from ? REPLY_TO[from.relation] : undefined;
  // The client always hears back; anyone else when they asked us something (a document arriving is acknowledged by its own rule).
  const asked = lines.some((l) => l.kind === 'question');
  if (reply && (from?.relation === 'client' || asked)) out.set(reply, { to: reply, purposes: ['Reply to their email, answering every point they made'], on: true, sentences: [] });
  const relation = from?.relation ?? 'unknown';
  for (const r of RECIPIENT_RULES) {
    if (!r.from.includes(relation)) continue;
    for (const l of lines) {
      if (!r.when(l)) continue;
      const cur = out.get(r.to);
      const purpose = r.purpose(l);
      const sentence = r.sentence(l);
      if (cur) { if (!cur.purposes.includes(purpose)) cur.purposes.push(purpose); if (!cur.sentences.includes(sentence)) cur.sentences.push(sentence); cur.on = cur.on || r.on; }
      else out.set(r.to, { to: r.to, purposes: [purpose], on: r.on, sentences: [sentence] });
    }
  }
  return [...out.values()];
}

export const PARTY_LABEL: Record<MessageParty, string> = { client: 'The Client', seller_solicitor: "The Other Side's Solicitor", estate_agent: 'The Estate Agent', lender: 'The Lender Or Broker' };
