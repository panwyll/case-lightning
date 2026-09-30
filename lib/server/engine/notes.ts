/**
 * Notes and call transcripts → proposed case events (docs/intake.md).
 *
 * A conveyancer rings a client. The client says they are happy with the damp report and
 * wants to proceed, and mentions the broker expects a revised offer on Friday. Today that
 * conversation lives in somebody's memory and, at best, a file note nobody re-reads.
 *
 * This module turns those words into PROPOSALS — never into state. Each proposal:
 *   • maps to exactly one command the machine already accepts (a client decision, or an
 *     issue), so nothing can enter the case by a side door;
 *   • must quote the words it came from, verbatim, or it is thrown away. A model that
 *     invents an instruction nobody gave cannot point at the sentence that gave it;
 *   • is applied only when a person approves it, because a transcript is one person's
 *     account of what was said and the conveyancer owns the file.
 *
 * The extractor itself is a port. Without a model key the deterministic reader below
 * still catches the unambiguous phrasings, so the feature degrades to "less", not "wrong".
 */
import { CLIENT_DECISION_OUTCOMES, CLIENT_DECISION_SUBJECTS, AVAILABILITY_PARTIES, type AvailabilityParty, type ClientDecisionSubject, type NoteAction, type NoteActionKind, type NoteCommand, type NoteKind, type NoteSender, type SenderRelation } from './types';
import { ISSUE_RESOLUTIONS, RESOLUTION_LABEL } from './issues';
import { ISSUE_KIND_SPEC, type IssueGate, type IssueKind } from './issues';

/** What an extractor hands back, before validation. */
export interface NoteActionDraft {
  kind: NoteActionKind;
  summary: string;
  quote: string;
  confidence?: number;
  command?: NoteCommand | null;
}

export interface NoteExtractionContext {
  tenantId: string;
  matterId: string;
  text: string;
  kind: NoteKind;
  /** A one-line account of the matter, so an extractor can tell "the survey" from "a survey". */
  caseLine?: string;
  /** For an email: who sent it, as far as the case knows. */
  from?: NoteSender | null;
  /** Today, so "14 November" gets the right year. */
  now?: string;
  /** Files that came with the email, and what each was read as: "attached" is about these, not a claim. */
  attachments?: string[];
  /** What we last told the client that this may be a reply to (the survey advice). */
  context?: string;
}

/** Issues that word from the right person may close: waits and chain positions, never a defect or a check. */
export const RESOLVABLE_ON_SOMEONES_WORD: IssueKind[] = ['chain_dependency', 'seller_delay', 'buyer_delay', 'search_delayed', 'enquiry_unanswered', 'mortgage_offer_outstanding', 'freeholder_info_outstanding', 'survey_report_outstanding', 'transaction_at_risk'];

/** Where a note's words come from: decides what they may propose. */
export interface NoteSource { kind: NoteKind; from?: NoteSender | null }

export const RELATION_LABEL: Record<SenderRelation, string> = {
  client: 'the client',
  agent: 'the estate agent',
  other_side: "the other side",
  lender: 'the lender or broker',
  colleague: 'a colleague',
  unknown: 'someone the case does not know',
};

/**
 * What the sender is allowed to put in front of a person. Only the client can make a
 * client decision: an agent saying "the buyer is happy with the survey" is hearsay and is
 * shown for information. A problem may be reported by anyone. Nothing anyone says can
 * clear ID, AML, source of funds or a search: those are not commands a note can name,
 * so the machine has no door for them (commandProblem).
 */
export function senderPolicy(source: NoteSource | undefined, action: NoteAction): NoteAction[] {
  if (!source || source.kind !== 'email') return [action];
  const relation = source.from?.relation ?? 'unknown';
  // Dates for exchange or completion: the targets are the conveyancer's to set (a person approves),
  // and the client's agreement to a completion date is the client's alone: recorded when they say it,
  // asked for when someone else does.
  if (action.command?.type === 'set_target_dates') {
    const c = action.command;
    const when = c.targetCompletionDate ? prettyDate(c.targetCompletionDate) : c.targetExchangeDate ? prettyDate(c.targetExchangeDate) : null;
    const subject = c.targetCompletionDate ? 'completion_date' : null;
    if (!subject || !when) return [action];
    if (relation === 'client') {
      return [action, { ...action, id: `${action.id}b`, kind: 'client_decision', summary: `The client agrees to complete on ${when}`, command: { type: 'client_decision_recorded', subject, decision: 'agreed', note: action.quote.slice(0, 400) } }];
    }
    const saidBy = source.from?.name || source.from?.address || RELATION_LABEL[relation];
    return [action, { ...action, id: `${action.id}b`, kind: 'confirm_with_client', summary: `${RELATION_LABEL[relation]} says completion on ${when}. Ask the client to confirm the date`, command: { type: 'confirm_with_client', subject, decision: 'agreed', saidBy, quote: action.quote, detail: when } }];
  }
  // A renegotiated price: the file is amended (a person approves) and, unless the client said it, the client is asked to confirm the new terms.
  if (action.command?.type === 'record_price_change' && relation !== 'client') {
    const c = action.command;
    const terms = c.toPennies ? `a revised price of ${pounds(c.toPennies)}` : `a price reduction of ${pounds(c.reductionPennies ?? 0)}`;
    const saidBy = source.from?.name || source.from?.address || RELATION_LABEL[relation];
    return [action, { ...action, id: `${action.id}b`, kind: 'confirm_with_client', summary: `${RELATION_LABEL[relation]} says ${terms} is agreed. Ask the client to confirm`, command: { type: 'confirm_with_client', subject: 'accept_terms', decision: 'accepted', saidBy, quote: action.quote, detail: terms } }];
  }
  // Who is away is who wrote in: the party comes from the sender, and a stranger's plans are not the case's.
  if (action.command?.type === 'record_availability') {
    const party: AvailabilityParty | null = relation === 'client' ? 'client' : relation === 'other_side' ? 'seller_side' : relation === 'agent' ? 'agent' : relation === 'lender' ? 'lender' : null;
    if (!party) return [{ ...action, kind: 'information', command: null, summary: `${action.summary} (from ${RELATION_LABEL[relation]}; not recorded)` }];
    return [{ ...action, summary: action.summary.replace(/^The client/, party === 'client' ? 'The client' : AVAILABILITY_PARTY_LABEL[party].replace(/^the /, 'The ')), command: { ...action.command, party } }];
  }
  // The lender or broker reporting a problem with the offer: the confirmation goes back to them, and the client hears.
  if (action.command?.type === 'raise_issue' && action.command.kind === 'mortgage_at_risk' && relation === 'lender') {
    return [{ ...action, command: { ...action.command, detail: `Reported by the lender or broker. ${action.command.detail ?? ''}`.trim() } }];
  }
  // Whether to have a survey is the client's call: anyone else saying so is put to the client.
  if (action.command?.type === 'record_survey_plan' && relation !== 'client' && relation !== 'colleague') {
    return [{ ...action, kind: 'information', command: null, summary: `${action.summary} (from ${RELATION_LABEL[relation]}, not the client; not recorded)` }];
  }
  // A copy of the client's file goes only to the client, on their own asking (or a colleague's).
  if (action.command?.type === 'send_file_copy' && relation !== 'client' && relation !== 'colleague') {
    return [{ ...action, kind: 'information', command: null, summary: `${action.summary} (asked by ${RELATION_LABEL[relation]}, not the client; nothing is sent on their say-so)` }];
  }
  // Only our client (or someone in the firm) tells us what to ask the other side for.
  if (action.command?.type === 'request_from_seller' && relation !== 'client' && relation !== 'colleague') {
    return [{ ...action, kind: 'information', command: null, summary: `${action.summary} (asked by ${RELATION_LABEL[relation]}, not the client; nothing goes to the seller on their say-so)` }];
  }
  // Only the client or the other side closes a wait on their word; an agent's "the chain is ready" is a claim to check.
  if (action.command?.type === 'resolve_issue' && relation !== 'client' && relation !== 'other_side' && relation !== 'colleague') {
    return [{ ...action, kind: 'information', command: null, summary: `${action.summary} (said by ${RELATION_LABEL[relation]}; confirm with the solicitors before closing it)` }];
  }
  if (action.command?.type === 'client_decision_recorded' && relation !== 'client') {
    // Hearsay about the client is not dropped: the client is asked, and their own answer is what gets recorded.
    const saidBy = source.from?.name || source.from?.address || RELATION_LABEL[relation];
    return [{
      ...action,
      kind: 'confirm_with_client',
      summary: `${RELATION_LABEL[relation]} says: ${action.summary.replace(/^The client /, 'the client ')}. Ask the client to confirm; nothing is recorded until they do`,
      command: { type: 'confirm_with_client', subject: action.command.subject, decision: action.command.decision, saidBy, quote: action.quote },
    }];
  }
  return [action];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
const pad = (n: number) => String(n).padStart(2, '0');
/**
 * Dates as people write them in email: "14 November", "14th Nov 2026", "Nov 14", "14/11/26".
 * A missing year is this year, or next if that day is already more than a month gone.
 */
export function datesIn(text: string, now: Date): Array<{ iso: string; index: number }> {
  const out: Array<{ iso: string; index: number }> = [];
  const y0 = now.getUTCFullYear();
  const settle = (day: number, month: number, year: number | null, index: number) => {
    if (day < 1 || day > 31 || month < 0 || month > 11) return;
    let y = year ?? y0;
    if (year !== null && year < 100) y = 2000 + year;
    let d = new Date(Date.UTC(y, month, day));
    if (year === null && d.getTime() < now.getTime() - 30 * 86_400_000) d = new Date(Date.UTC(y + 1, month, day));
    if (d.getUTCMonth() !== month) return; // 31 February
    out.push({ iso: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, index });
  };
  const month = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase());
  const dm = /\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}|\d{2})\b)?/gi;
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4})\b)?/gi;
  const num = /\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4}|\d{2})\b/g;
  const seen = new Set<number>();
  for (const m of text.matchAll(dm)) { seen.add(m.index!); settle(Number(m[1]), month(m[2]), m[3] ? Number(m[3]) : null, m.index!); }
  for (const m of text.matchAll(md)) { if (![...seen].some((i) => Math.abs(i - m.index!) < 12)) { seen.add(m.index!); settle(Number(m[2]), month(m[1]), m[3] ? Number(m[3]) : null, m.index!); } }
  for (const m of text.matchAll(num)) settle(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m.index!);
  out.sort((a, b) => a.index - b.index);
  // "from 10 October until the 20th": a bare day after a dated one is in the same month.
  if (out.length) {
    const bare = /\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/gi;
    for (const m of text.matchAll(bare)) {
      if (out.some((d) => Math.abs(d.index - m.index!) < 3)) continue;
      const prev = [...out].reverse().find((d) => d.index < m.index!);
      if (!prev) continue;
      const [y, mo] = prev.iso.split('-').map(Number);
      const day = Number(m[1]);
      const d = new Date(Date.UTC(y, mo - 1, day));
      if (d.getUTCMonth() !== mo - 1) continue;
      out.push({ iso: `${y}-${pad(mo)}-${pad(day)}`, index: m.index! });
    }
    out.sort((a, b) => a.index - b.index);
  }
  return out;
}

/** A UK sort code and account number in the text, with the account name if one is given beside them. */
export function bankDetailsIn(text: string): { sortCode: string; accountNumber: string; accountName: string | null } | null {
  const sort = text.match(/\b(\d{2})[-\s]?(\d{2})[-\s]?(\d{2})\b(?![-\s]?\d)/);
  const acct = text.match(/\b(\d{8})\b/);
  if (!sort || !acct) return null;
  const name = text.match(/(?:account name|a\/c name|name on the account|payee)\s*[:\-]?\s*([^\n,]{2,80})/i);
  return { sortCode: `${sort[1]}${sort[2]}${sort[3]}`, accountNumber: acct[1], accountName: name ? name[1].trim() : null };
}

/** "£245,000", "£245k", "245,000 pounds" → pennies. */
export function poundsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/£\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?\s?(k|K)?\b|\b(\d{1,3}(?:,\d{3})+|\d+)\s?(k|K)?\s+(?:pounds|quid)\b/g)) {
    const whole = (m[1] ?? m[4] ?? '').replace(/,/g, '');
    const k = m[3] ?? m[5];
    if (!whole) continue;
    const pennies = Math.round(Number(whole) * (k ? 1000 : 1) * 100 + Number(m[2] ?? 0));
    if (pennies > 0) out.push(pennies);
  }
  return out;
}

/** "exchange on 7 Nov and complete on 14 Nov": each date belongs to the nearest exchange/completion word before it. */
export function targetDatesIn(sentence: string, now: Date): { targetExchangeDate: string | null; targetCompletionDate: string | null } | null {
  const dates = datesIn(sentence, now);
  if (!dates.length) return null;
  const lower = sentence.toLowerCase();
  const mentionsExchange = /\bexchang/.test(lower);
  const mentionsCompletion = /\bcomplet|\bmove in|\bmoving (in|day|date)|\bkeys\b/.test(lower);
  if (!mentionsExchange && !mentionsCompletion) return null;
  let ex: string | null = null;
  let co: string | null = null;
  for (const d of dates) {
    const before = lower.slice(0, d.index);
    const lastEx = before.lastIndexOf('exchang');
    const lastCo = Math.max(before.lastIndexOf('complet'), before.lastIndexOf('move in'), before.lastIndexOf('moving'), before.lastIndexOf('keys'));
    const which = lastEx < 0 && lastCo < 0 ? (mentionsExchange && !mentionsCompletion ? 'ex' : mentionsCompletion && !mentionsExchange ? 'co' : null) : lastEx > lastCo ? 'ex' : 'co';
    if (which === 'ex' && !ex) ex = d.iso;
    else if (which === 'co' && !co) co = d.iso;
  }
  if (!ex && !co) return null;
  return { targetExchangeDate: ex, targetCompletionDate: co };
}

/** What the system does once an issue of this kind is raised: the panel says it, the service does it (issue_raised reactions). */
export function issueConsequence(kind: string): string | null {
  switch (kind) {
    case 'survey_report_outstanding': return 'asks the client to send us the survey report, and chases it';
    case 'mortgage_at_risk': return 'asks the client what has changed and tells them the lender must hear of it before exchange';
    case 'transaction_at_risk': return "asks the seller's solicitor to confirm whether their client is proceeding";
    case 'unknown_correspondent': return 'nothing they said counts until you set who they are on the case';
    default: return null;
  }
}

export const pounds = (pennies: number): string => `£${(pennies / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
export const AVAILABILITY_PARTY_LABEL: Record<AvailabilityParty, string> = { client: 'the client', seller_side: "the seller's side", agent: 'the estate agent', lender: 'the lender or broker' };

const DECISION_SHORT: Record<string, string> = {
  'physical_condition:satisfied': 'satisfied with the property',
  'physical_condition:renegotiate': 'wants to renegotiate',
  'physical_condition:further_investigation': 'wants further investigation',
  'physical_condition:withdraw': 'withdraws',
  'further_investigation:pursue': 'wants the specialists in',
  'further_investigation:evidence': "wants the seller's evidence first",
  'further_investigation:waive': 'waives the investigation',
  'exchange_authority:authorised': 'authorises exchange',
  'exchange_authority:not_yet': 'not ready to exchange',
  'exchange_authority:withdrawn': 'withdraws authority to exchange',
  'completion_date:agreed': 'agrees the completion date',
  'completion_date:declined': 'declines the completion date',
  'accept_terms:accepted': 'accepts the terms',
  'accept_risk:accepted': 'accepts the risk',
};
const decisionShort = (subject: string, decision: string) => DECISION_SHORT[`${subject}:${decision}`] ?? `${subject.replace(/_/g, ' ')}: ${decision.replace(/_/g, ' ')}`;
const dayShort = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** A task title for one proposed line: what it would put on the case, in a few words. */
export function commandTitle(c: NoteCommand): string {
  switch (c.type) {
    case 'client_decision_recorded': return `Client decision: ${decisionShort(c.subject, c.decision)}`;
    case 'confirm_with_client': return `Confirm with the client: ${decisionShort(c.subject, c.decision)}`;
    case 'set_target_dates': return `Target dates: ${[c.targetExchangeDate ? `exchange ${dayShort(c.targetExchangeDate)}` : null, c.targetCompletionDate ? `completion ${dayShort(c.targetCompletionDate)}` : null].filter(Boolean).join(', ')}`;
    case 'record_price_change': return c.toPennies ? `Price change: ${pounds(c.toPennies)}` : `Price reduction: ${pounds(c.reductionPennies ?? 0)}`;
    case 'resolve_issue': return `Close: ${ISSUE_KIND_SPEC[c.kind]?.label ?? c.kind.replace(/_/g, ' ')}`;
    case 'request_from_seller': return `Ask the seller: ${c.about.trim().slice(0, 80) || 'as the client instructed'}`;
    case 'send_file_copy': return `Send the client a copy: ${c.what.trim().slice(0, 80)}`;
    case 'record_availability': return `${AVAILABILITY_PARTY_LABEL[c.party].replace(/^the /, '').replace(/^./, (x) => x.toUpperCase())} away ${dayShort(c.from)} to ${dayShort(c.until)}`;
    case 'record_survey_plan': return c.plan === 'none' ? 'No survey: the client\'s choice' : `Survey booked${c.date ? ` for ${dayShort(c.date)}` : ''}`;
    case 'raise_issue': return `Issue: ${ISSUE_KIND_SPEC[c.kind]?.label ?? c.kind.replace(/_/g, ' ')}`;
  }
}
/**
 * An email the reader could not turn into something for the case (not a request, an update, an issue or a
 * decision it could be sure of): it goes to a person to read and answer. Not being sure is a reason to ask,
 * never a reason to file it away (docs/spec/triggers.md).
 */
export function nothingToActSummary(text: string, from?: NoteSender | null): string {
  const who = from ? `${from.name || from.address} (${RELATION_LABEL[from.relation]})` : 'someone';
  const first = text.split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' ').slice(0, 300);
  return [`An email from ${who}. The system could not be sure what it needs, so it is for you to read and answer.`, '', first ? `It begins: “${first}${text.length > first.length ? '…' : ''}”` : '', '', 'Approve once it is dealt with (answered, or nothing is needed). If the case should change, reject and say what, or raise it from the case.'].filter((l, i, a) => l || a[i - 1]).join('\n');
}
/** An acknowledgement put before a person (the no-reply action at Propose): one click confirms nobody needs to reply. */
export function acknowledgementSummary(text: string, from?: NoteSender | null): string {
  const who = from ? `${from.name || from.address} (${RELATION_LABEL[from.relation]})` : 'someone';
  const first = text.split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 200);
  return [`An acknowledgement from ${who}: “${first}”. Read against the conversation, nothing in it needs a reply or changes the case.`, '', 'Approve to confirm no reply is needed. Reject if it does, and say what.'].join('\n');
}
/** Whose email it is, for the task: "the client's", "Jo Smith's". */
const whose = (from?: NoteSender | null): string => {
  if (from?.relation && from.relation !== 'unknown' && from.relation !== 'colleague') return RELATION_LABEL[from.relation].replace(/^the lender or broker$/, 'the lender').replace(/$/, "'s");
  const n = from?.name || from?.address || 'the sender';
  return `${n}'s`;
};
/** An acknowledgement's task: confirm nobody needs to reply. */
export function acknowledgementTitle(from?: NoteSender | null, text = ''): string {
  const words = text.split(/\n/).map((l) => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 90);
  return `Confirm no reply is needed to ${whose(from)} acknowledgement${words ? `: “${words}”` : ''}`;
}
/** A read-and-reply task: what the person does with an email nothing was proposed from. */
export function nothingToActTitle(from?: NoteSender | null): string {
  return `Read and reply to ${whose(from)} email`;
}
/** The chip on an email's task: whose email it is. */
export function emailChip(from?: NoteSender | null): string {
  const r = from?.relation ?? 'unknown';
  return r === 'client' ? 'Client Email' : r === 'agent' ? 'Agent Email' : r === 'other_side' ? "Other Side's Email" : r === 'lender' ? 'Lender Email' : r === 'colleague' ? 'Colleague Email' : 'Unknown Sender Email';
}

/** The title of a note's task: its first proposed line, and how many more. */
export function noteTaskTitle(actions: Array<{ command: NoteCommand | null }>): string | null {
  const cmds = actions.map((a) => a.command).filter((c): c is NoteCommand => !!c);
  if (!cmds.length) return null;
  return `${commandTitle(cmds[0])}${cmds.length > 1 ? ` (+${cmds.length - 1} more)` : ''}`;
}

/** What applying this command does, as the person sees it before they tick the line. */
export function effectText(c: NoteCommand): string {
  switch (c.type) {
    case 'client_decision_recorded': return `Records the client's decision: ${c.subject.replace(/_/g, ' ')}, ${c.decision.replace(/_/g, ' ')}`;
    case 'confirm_with_client': return `Asks the client to confirm that ${claimText(c.subject, c.decision, c.detail)}; recorded only when they say so`;
    case 'set_target_dates': return `Sets the target dates: ${[c.targetExchangeDate ? `exchange ${prettyDate(c.targetExchangeDate)}` : null, c.targetCompletionDate ? `completion ${prettyDate(c.targetCompletionDate)}` : null].filter(Boolean).join(', ')}`;
    case 'record_price_change': return c.toPennies ? `Records the price as ${pounds(c.toPennies)}${c.reductionPennies ? '' : ''} and tells the lender if there is one` : `Records a price reduction of ${pounds(c.reductionPennies ?? 0)} and tells the lender if there is one`;
    case 'resolve_issue': return `Closes the open "${ISSUE_KIND_SPEC[c.kind]?.label ?? c.kind}" issue as ${RESOLUTION_LABEL[c.resolution]?.toLowerCase() ?? c.resolution}`;
    case 'send_file_copy': return `Finds ${c.what.trim().slice(0, 80)} on the case and proposes a reply to the client with it attached (a task if it is not on file)`;
    case 'request_from_seller': return `Proposes this enquiry to the seller's solicitor (editable before it goes): ${c.text.trim().slice(0, 300)}${c.text.trim().length > 300 ? '…' : ''}`;
    case 'record_survey_plan': return c.plan === 'none' ? 'Records that the client has chosen not to have a survey; they are no longer asked about one' : `Records the survey as booked${c.date ? ` for ${prettyDate(c.date)}` : ''}; the client is not asked about it again until after that date`;
    case 'record_availability': return `Notes that ${AVAILABILITY_PARTY_LABEL[c.party]} is away ${prettyDate(c.from)} to ${prettyDate(c.until)}: chases to them wait, updates say so, and target dates are checked against it`;
    case 'raise_issue': return `Raises the issue "${ISSUE_KIND_SPEC[c.kind]?.label ?? c.kind}"${c.gate === 'none' ? '' : ` (holds ${c.gate})`}${issueConsequence(c.kind) ? ` and ${issueConsequence(c.kind)}` : ''}`;
  }
}

/** The claim put to the client, in their terms: "you are happy with the survey and want to proceed". */
export function claimText(subject: ClientDecisionSubject, decision: string, detail?: string | null): string {
  const k = `${subject}:${decision}`;
  if (k === 'completion_date:agreed') return `you are happy to complete on ${detail ?? 'the date proposed'}`;
  if (k === 'completion_date:declined') return `the completion date proposed does not work for you`;
  if (k === 'accept_terms:accepted' && detail) return `you have agreed ${detail}`;
  const known: Record<string, string> = {
    'physical_condition:satisfied': 'you are happy with the survey and want to proceed',
    'physical_condition:renegotiate': 'you want to renegotiate the price following the survey',
    'physical_condition:further_investigation': 'you want the further investigation the surveyor recommended',
    'physical_condition:withdraw': 'you no longer wish to proceed with the purchase',
    'further_investigation:pursue': 'you want the further investigation the surveyor recommended carried out',
    'further_investigation:waive': 'you are content to proceed without the further investigation the surveyor recommended',
    'further_investigation:evidence': "you would like us to ask the seller for any reports, certificates or guarantees before arranging inspections",
    'exchange_authority:authorised': 'you authorise us to exchange contracts',
    'exchange_authority:not_yet': 'you are not yet ready for us to exchange contracts',
    'exchange_authority:withdrawn': 'you have withdrawn your authority to exchange contracts',
  };
  return known[k] ?? `your decision on ${subject.replace(/_/g, ' ')} is "${decision.replace(/_/g, ' ')}"`;
}

/** Whitespace-insensitive containment: a quote must really be in the note. */
const norm = (s: string) => s.toLowerCase().replace(/[‘’“”]/g, "'").replace(/\s+/g, ' ').trim();

export interface ValidationResult {
  actions: NoteAction[];
  /** What was dropped and why — kept so the log can show that something was refused. */
  rejected: Array<{ summary: string; reason: string }>;
}

/**
 * Keep only the proposals that (a) quote the note, (b) name a command the machine will
 * accept, and (c) are not duplicates. Everything else is dropped with a reason.
 */
export function validateNoteActions(text: string, drafts: NoteActionDraft[], source?: NoteSource): ValidationResult {
  const body = norm(text);
  const actions: NoteAction[] = [];
  const rejected: ValidationResult['rejected'] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    const summary = (d.summary ?? '').trim();
    const quote = (d.quote ?? '').trim();
    if (!summary) {
      rejected.push({ summary: '(no summary)', reason: 'the proposal says nothing' });
      continue;
    }
    if (!quote || !body.includes(norm(quote))) {
      rejected.push({ summary, reason: 'the quoted words are not in the note' });
      continue;
    }
    const key = `${d.kind}:${norm(summary)}`;
    if (seen.has(key)) {
      rejected.push({ summary, reason: 'duplicate' });
      continue;
    }
    let command: NoteCommand | null = null;
    if (d.command) {
      const bad = commandProblem(d.command);
      if (bad) {
        rejected.push({ summary, reason: bad });
        continue;
      }
      command = d.command;
    }
    seen.add(key);
    actions.push(...senderPolicy(source, {
      id: `A${actions.length + 1}`,
      kind: d.kind,
      summary,
      quote,
      confidence: typeof d.confidence === 'number' ? Math.max(0, Math.min(1, d.confidence)) : 0.6,
      command,
    }));
  }
  return { actions, rejected };
}

/** Why this command could never run. null = it is a command the machine accepts. */
export function commandProblem(c: NoteCommand): string | null {
  if (c.type === 'client_decision_recorded' || c.type === 'confirm_with_client') {
    if (!(CLIENT_DECISION_SUBJECTS as readonly string[]).includes(c.subject)) return `"${c.subject}" is not a client decision the engine knows`;
    const allowed = CLIENT_DECISION_OUTCOMES[c.subject as ClientDecisionSubject] ?? [];
    if (!allowed.includes(c.decision)) return `"${c.decision}" is not an outcome for ${c.subject.replace(/_/g, ' ')}`;
    return null;
  }
  if (c.type === 'set_target_dates') {
    if (!c.targetExchangeDate && !c.targetCompletionDate) return 'no date was given';
    for (const d of [c.targetExchangeDate, c.targetCompletionDate]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return `"${d}" is not a date (YYYY-MM-DD)`;
    return null;
  }
  if (c.type === 'record_price_change') {
    if (!c.toPennies && !c.reductionPennies) return 'no price was given';
    for (const v of [c.toPennies, c.reductionPennies]) if (v != null && (!Number.isInteger(v) || v <= 0)) return 'the price must be a positive whole number of pennies';
    if (!c.reason?.trim()) return 'a price change needs a reason';
    return null;
  }
  if (c.type === 'resolve_issue') {
    if (!RESOLVABLE_ON_SOMEONES_WORD.includes(c.kind)) return `a "${c.kind}" issue is not closed on someone's word`;
    if (!(ISSUE_RESOLUTIONS as readonly string[]).includes(c.resolution)) return `"${c.resolution}" is not a resolution`;
    if (!ISSUE_KIND_SPEC[c.kind].resolutions.includes(c.resolution)) return `"${ISSUE_KIND_SPEC[c.kind].label}" is not resolved by "${c.resolution}"`;
    return null;
  }
  if (c.type === 'send_file_copy') return c.what?.trim() ? null : 'it does not say which document';
  if (c.type === 'request_from_seller') {
    if (!c.text?.trim() || c.text.trim().length < 20) return 'the request says nothing';
    if (c.text.length > 4000) return 'the request is too long for one enquiry';
    return null;
  }
  if (c.type === 'record_survey_plan') {
    if (c.plan !== 'none' && c.plan !== 'booked') return `"${c.plan}" is not a survey plan`;
    if (c.date && !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) return `"${c.date}" is not a date (YYYY-MM-DD)`;
    return null;
  }
  if (c.type === 'record_availability') {
    if (!AVAILABILITY_PARTIES.includes(c.party)) return `"${c.party}" is not a party`;
    for (const d of [c.from, c.until]) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return `"${d}" is not a date (YYYY-MM-DD)`;
    if (c.until < c.from) return 'the period ends before it starts';
    return null;
  }
  if (c.type === 'raise_issue') {
    if (!ISSUE_KIND_SPEC[c.kind as IssueKind]) return `"${c.kind}" is not an issue kind`;
    if (!c.title?.trim()) return 'the issue has no title';
    if (!['exchange', 'completion', 'none'].includes(c.gate)) return `"${c.gate}" is not a gate`;
    return null;
  }
  return 'unknown command';
}

/** The decision a person sees: what the note appears to say, and the words behind each line. */
export function summariseNoteActions(input: { kind: NoteKind; text: string; actions: NoteAction[]; author?: string | null; from?: NoteSender | null }): string {
  const L: string[] = [];
  const who = input.from ? `${input.from.name || input.from.address} (${RELATION_LABEL[input.from.relation]})` : 'someone';
  const source = input.kind === 'call' ? 'A call' : input.kind === 'dictated' ? 'A dictated note' : input.kind === 'meeting' ? 'A meeting note' : input.kind === 'email' ? `An email from ${who}` : 'A note';
  L.push(`${source} on this matter appears to record ${input.actions.length} thing${input.actions.length === 1 ? '' : 's'} the case should know about. Nothing has been applied — approve to apply, or reject with a reason.`);
  L.push('');
  for (const a of input.actions) {
    const effect = !a.command ? 'For information only — nothing to record.' : `${effectText(a.command)}.`;
    L.push(`${a.id}. ${a.summary}`);
    L.push(`    “${a.quote}”`);
    L.push(`    ${effect}`);
  }
  L.push('');
  L.push('The note itself is on the file as the evidence for every line above.');
  return L.join('\n');
}

// ───────────────────────────── the deterministic reader ─────────────────────────────

/**
 * What a careful reader can take from a note without a model: only unambiguous phrasings,
 * each anchored to the sentence it came from. Conservative on purpose — everything it
 * proposes still goes to a person, but a false positive wastes that person's attention.
 */
const SENTENCE = /[^.!?\n]+[.!?]?/g;

interface Rule {
  test: RegExp;
  /** A second condition the same sentence must meet (e.g. "survey" AND "happy"). */
  also?: RegExp;
  /** Not this — a negation or a different subject. */
  not?: RegExp;
  build: (sentence: string) => NoteActionDraft;
}

const RULES: Rule[] = [
  {
    // "happy with the survey and wants to proceed" — the client's view of the physical condition.
    test: /\b(happy|satisfied|content|fine)\b/i,
    also: /\b(survey|report|damp|timber|structural|valuation|condition)\b/i,
    not: /\b(not|isn'?t|unhappy|un-?satisfied|except|but not)\b/i,
    build: (sentence) => ({
      kind: 'client_decision',
      summary: 'The client is satisfied with the physical condition of the property',
      quote: sentence,
      confidence: 0.72,
      command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'satisfied', note: sentence.trim().slice(0, 400) },
    }),
  },
  {
    // "wants to renegotiate on the back of the damp report"
    test: /\b(renegotiat|reduce the price|price reduction|knock (something|money) off)\b/i,
    build: (sentence) => ({
      kind: 'client_decision',
      summary: 'The client wants to renegotiate after the survey',
      quote: sentence,
      confidence: 0.7,
      command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'renegotiate', note: sentence.trim().slice(0, 400) },
    }),
  },
  {
    // "authorises us to exchange" — the client's authority, which the firm may require.
    test: /\b(authoris|authoriz)\w*\b.*\bexchange\b|\bexchange\b.*\b(authoris|authoriz)\w*/i,
    not: /\b(not|cannot|can'?t|won'?t|hold off|wait)\b/i,
    build: (sentence) => ({
      kind: 'client_decision',
      summary: 'The client authorises exchange',
      quote: sentence,
      confidence: 0.7,
      command: { type: 'client_decision_recorded', subject: 'exchange_authority', decision: 'authorised', note: sentence.trim().slice(0, 400) },
    }),
  },
  {
    // "broker expects the revised offer on Friday" — something we are now waiting for.
    test: /\b(expect\w*|due|coming|chasing|should (have|come|arrive|be))\b/i,
    also: /\b(offer|mortgage|lender|broker|pack|replies|statement|consent|search|report)\b/i,
    build: (sentence) => ({
      kind: 'expectation',
      summary: `Something is expected: ${sentence.trim().slice(0, 120)}`,
      quote: sentence,
      confidence: 0.55,
      command: { type: 'raise_issue', kind: expectedKind(sentence), title: sentence.trim().slice(0, 160), detail: 'Said in an email or a note: something is expected. The system chases it if it does not arrive.', gate: 'none' },
    }),
  },
  {
    // "surveys are all complete" — the report exists somewhere; ask for it. Nothing about the
    // property is recorded until the report itself is on file.
    test: /\bsurvey/i,
    also: /\b(done|complete|completed|back|through|carried out|finished|all in|has happened|took place|went ahead)\b/i,
    not: /\b(not|hasn'?t|haven'?t|isn'?t|aren'?t|yet|waiting|book|booked|arrang\w*|instruct\w*|when|once|will be|happy|satisfied|attach\w*|enclos\w*|here is|here's|herewith|sending)\b/i,
    build: (sentence) => ({
      kind: 'issue',
      summary: 'The survey has been done; the report is not on file yet',
      quote: sentence,
      confidence: 0.7,
      command: { type: 'raise_issue', kind: 'survey_report_outstanding', title: 'Survey done; ask the client for the report', detail: sentence.trim().slice(0, 400), gate: 'none' },
    }),
  },
  {
    // "the vendor has pulled out", "the chain has collapsed" — critical, and confirmed with the solicitors, never acted on.
    test: /\b(pull(ed|ing|s)? out|fallen through|fall(s|ing)? through|chain (has |is )?(collapsed|broken|gone)|gazump\w*|no longer (want\w*|wish\w*|able) to (proceed|buy|sell|go ahead)|not (going|proceeding) ahead|(vendor|seller|buyer|purchaser)s? (has |have |is |are )?(withdrawn|withdrawing))\b/i,
    build: (sentence) => ({
      kind: 'issue',
      summary: 'The transaction may be falling through',
      quote: sentence,
      confidence: 0.75,
      command: { type: 'raise_issue', kind: 'transaction_at_risk', title: sentence.trim().slice(0, 160), detail: 'Said in an email or a note. Confirm with the solicitors before anything is done about it.', gate: 'exchange' },
    }),
  },
  {
    // "my mortgage provider has rescinded their offer" — the offer is gone, not merely at risk: exchange cannot happen on it.
    test: /\b((lender|bank|provider|broker|building society|mortgage company|they|he|she)\s+(has |have |had )?(now )?(rescinded|revoked|withdrawn|withdrew|pulled|cancell?ed|retracted|declined|refused|turned down)\s+(the |their |my |our |its |his |her )?(mortgage )?(offer|mortgage|application|lending|loan)|(has |have |had )(now )?(rescinded|revoked|withdrawn|withdrew|pulled|cancell?ed|retracted)\s+(the |their |my |our |its |his |her )?(mortgage )?offer|(mortgage )?offer\s+(has been |was |is |got |has )?(rescinded|revoked|cancell?ed|retracted|withdrawn|pulled))\b/i,
    build: (sentence) => ({
      kind: 'issue',
      summary: 'The mortgage offer has been withdrawn',
      quote: sentence,
      confidence: 0.85,
      command: { type: 'raise_issue', kind: 'mortgage_at_risk', title: `Mortgage offer withdrawn: ${sentence.trim()}`.slice(0, 160), detail: 'Said in an email or a note. Confirm with the lender or broker that the offer is withdrawn and why; the purchase cannot exchange on it. Advise the client on a new application or lender.', gate: 'exchange', severity: 'critical' },
    }),
  },
  {
    // "I've lost my job so the mortgage may be a problem" — a change the lender must hear about before exchange.
    test: /\b(lost (my|his|her|their) job|redundan\w*|job (has )?changed|chang\w* (my|his|her|their) job|new job|(mortgage|offer|application) (is|may be|might be|could be|will be) (a problem|in doubt|at risk|affected)|(mortgage|offer|application) (may|might|could|will|is going to|is to) (be )?(withdrawn|declined|refused|pulled|rejected)|(mortgage|offer|application)( has been| was)? (declined|refused|withdrawn|rejected|pulled|rescinded|revoked|cancell?ed|retracted)|(income|salary|pay) (has )?(dropped|changed|reduced|gone down|fallen))\b/i,
    build: (sentence) => ({
      kind: 'issue',
      summary: 'The mortgage may be at risk',
      quote: sentence,
      confidence: 0.7,
      command: { type: 'raise_issue', kind: 'mortgage_at_risk', title: sentence.trim().slice(0, 160), detail: 'Said in an email or a note. Confirm with the broker whether the offer stands; report a material change to the lender before exchange.', gate: 'exchange' },
    }),
  },
  {
    // "my dad is giving us £20k towards the deposit" — a gift is a source-of-funds matter and a donor to identify.
    test: /\b(gift\w*|giving us|give us|lending us|lend us|helping (us|me) with the deposit|contribut\w* (to|towards) the deposit)\b/i,
    also: /\b(deposit|£|\d{1,3}(,\d{3})+|k\b|money|funds|towards)/i,
    build: (sentence) => ({
      kind: 'issue',
      summary: 'A gift or loan towards the purchase was mentioned',
      quote: sentence,
      confidence: 0.7,
      command: { type: 'raise_issue', kind: 'source_of_funds', title: `Gift or loan towards the purchase: ${sentence.trim().slice(0, 120)}`, detail: 'Said in an email or a note. The donor needs identifying and a gift letter; a loan needs the lender told.', gate: 'exchange' },
    }),
  },
  {
    // "I got married and my name has changed" — the ID on file no longer matches.
    test: /\b(changed? (my|her|his) name|name (has )?changed|got married|now (called|known as)|maiden name|deed poll)\b/i,
    build: (sentence) => ({
      kind: 'issue',
      summary: 'A change of name was mentioned',
      quote: sentence,
      confidence: 0.7,
      command: { type: 'raise_issue', kind: 'cdd_refresh', title: `Name change mentioned: ${sentence.trim().slice(0, 120)}`, detail: 'Said in an email or a note. Evidence of the change (marriage certificate, deed poll) is needed before the transfer and the lender documents.', gate: 'exchange' },
    }),
  },
  {
    // "we are away 10–20 October" — the timetable has to work around it.
    test: /\b(away|on holiday|abroad|out of the country|unavailable|not around|off grid)\b/i,
    also: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|week|weekend|from|until|till|between)\b/i,
    build: (sentence) => ({
      kind: 'issue',
      summary: 'The client will be unavailable for a period',
      quote: sentence,
      confidence: 0.6,
      command: { type: 'raise_issue', kind: 'buyer_delay', title: `Client unavailable: ${sentence.trim().slice(0, 120)}`, detail: 'Said in an email or a note. Plan signing, exchange and completion around it.', gate: 'none' },
    }),
  },
  {
    // "the chain is now complete / everyone is ready" — closes the chain wait, on the right person's word.
    test: /\b(chain (is|are) (now )?(complete|ready|in place|all set)|top of the chain is (now )?ready|everyone (in the chain )?is (now )?ready|no (onward )?chain|chain[- ]free)\b/i,
    not: /\b(not|isn'?t|aren'?t|still|hope|hopefully|should be|once|when)\b/i,
    build: (sentence) => ({
      kind: 'information',
      summary: 'The chain is reported ready',
      quote: sentence,
      confidence: 0.65,
      command: { type: 'resolve_issue', kind: 'chain_dependency', resolution: 'chain_ready', note: sentence.trim().slice(0, 300) },
    }),
  },
  {
    // "we've agreed £5,000 off" / "the price is now £245,000" — the file's price, once a person approves; the client confirms unless they said it.
    test: /\b(agreed|accepted|reduc\w*|knock\w*|price (is|will be) now|new price|revised price|come down|drop\w*|off the (price|asking))\b/i,
    also: /£\s?\d|\d\s?(k|K)\b|\bpounds\b/,
    not: /\b(deposit|gift|fee|fees|retention|stamp duty|sdlt|rent|service charge|ground rent|survey cost|quote)\b/i,
    build: (sentence) => {
      const amounts = poundsIn(sentence);
      const off = /\b(off|reduction of|reduce\w* by|knock\w*|down by|drop\w* by)\b/i.test(sentence);
      const amount = amounts[0] ?? 0;
      const command: NoteCommand = off ? { type: 'record_price_change', toPennies: null, reductionPennies: amount, reason: sentence.trim().slice(0, 200) } : { type: 'record_price_change', toPennies: amount, reductionPennies: null, reason: sentence.trim().slice(0, 200) };
      return { kind: 'information', summary: off ? `A price reduction of ${pounds(amount)} was mentioned` : `A revised price of ${pounds(amount)} was mentioned`, quote: sentence, confidence: 0.65, command };
    },
  },
  {
    // a problem mentioned in passing — raised as an issue for a person to classify properly.
    test: /\b(boundary|dispute|japanese knotweed|knotweed|subsidence|flying freehold|unregistered|no building regs?|without (planning|building)|damp problem|leak)\b/i,
    build: (sentence) => ({
      kind: 'issue',
      summary: `A possible problem was mentioned: ${sentence.trim().slice(0, 120)}`,
      quote: sentence,
      confidence: 0.6,
      command: { type: 'raise_issue', kind: 'boundary_discrepancy', title: sentence.trim().slice(0, 160), detail: 'Mentioned in a note; classify it properly when you pick it up.', gate: 'none' },
    }),
  },
];

/** What is expected decides which wait it is: the offer, the replies, the pack, the search. */
function expectedKind(sentence: string): IssueKind {
  const s = sentence.toLowerCase();
  if (/\b(offer|mortgage|lender|broker|underwrit)/.test(s)) return 'mortgage_offer_outstanding';
  if (/\bsearch/.test(s)) return 'search_delayed';
  if (/\b(management|freeholder|managing agent|lpe1)/.test(s)) return 'freeholder_info_outstanding';
  if (/\b(repl|enquir|answer|pack|contract|forms?)\b/.test(s)) return 'seller_delay';
  return 'seller_delay';
}

const DATE_RULE: Rule = {
  // "we'd like to exchange on 7 Nov and complete on the 14th of November" — targets for a person to set.
  test: /\b(exchang\w*|complet\w*|move in|moving (in|day|date)|keys)\b/i,
  also: /\d/,
  not: /\b(exchanged|completed) on\b/i,
  build: (sentence) => ({ kind: 'information', summary: sentence.trim().slice(0, 120), quote: sentence, confidence: 0.6 }),
};

export class DeterministicNoteReader {
  readonly name = 'deterministic-note-reader';
  async extract(input: NoteExtractionContext): Promise<NoteActionDraft[]> {
    const sentences = (input.text.match(SENTENCE) ?? []).map((s) => s.trim()).filter((s) => s.length > 8);
    const out: NoteActionDraft[] = [];
    const used = new Set<string>();
    const now = input.now ? new Date(input.now) : new Date();
    for (const sentence of sentences) {
      // "we are away from 10 October until the 20th" — a window, when both ends are there.
      if (/\b(away|on holiday|abroad|out of the country|unavailable|not around|off grid|on leave|out of (the )?office)\b/i.test(sentence)) {
        const ds = datesIn(sentence, now);
        if (ds.length >= 2) {
          const from = ds[0].iso < ds[1].iso ? ds[0].iso : ds[1].iso;
          const until = ds[0].iso < ds[1].iso ? ds[1].iso : ds[0].iso;
          out.push({ kind: 'information', summary: `The client is away ${prettyDate(from)} to ${prettyDate(until)}`, quote: sentence, confidence: 0.7, command: { type: 'record_availability', party: 'client', from, until, note: sentence.trim().slice(0, 200) } });
          used.add(`issue:The client will be unavailable for a period`);
          continue;
        }
        if (ds.length === 1 && /\b(until|till|back on|return\w* on|through)\b/i.test(sentence)) {
          const until = ds[0].iso;
          const from = now.toISOString().slice(0, 10) < until ? now.toISOString().slice(0, 10) : until;
          out.push({ kind: 'information', summary: `The client is away until ${prettyDate(until)}`, quote: sentence, confidence: 0.65, command: { type: 'record_availability', party: 'client', from, until, note: sentence.trim().slice(0, 200) } });
          used.add(`issue:The client will be unavailable for a period`);
          continue;
        }
      }
      if (!DATE_RULE.test.test(sentence) || !DATE_RULE.also!.test(sentence) || DATE_RULE.not!.test(sentence)) continue;
      const dates = targetDatesIn(sentence, now);
      if (!dates) continue;
      out.push({ kind: 'information', summary: `Dates mentioned: ${[dates.targetExchangeDate ? `exchange ${prettyDate(dates.targetExchangeDate)}` : null, dates.targetCompletionDate ? `completion ${prettyDate(dates.targetCompletionDate)}` : null].filter(Boolean).join(', ')}`, quote: sentence, confidence: 0.65, command: { type: 'set_target_dates', ...dates, reason: sentence.trim().slice(0, 200) } });
      used.add(sentence);
    }
    for (const sentence of sentences) {
      for (const r of RULES) {
        if (!r.test.test(sentence)) continue;
        if (r.also && !r.also.test(sentence)) continue;
        if (r.not && r.not.test(sentence)) continue;
        const draft = r.build(sentence);
        const key = `${draft.kind}:${draft.summary}`;
        if (used.has(key)) continue;
        used.add(key);
        out.push(draft);
        break; // one reading per sentence — the most specific rule that fires
      }
    }
    return out;
  }
}

// ───────────────────────────── acknowledgements (no reply needed) ─────────────────────────────

/** Words a pure acknowledgement is made of. No word that can be an answer ("ok", "yes", "fine", "sure"): those go to a person. */
const ACK_WORDS = new Set([
  'thanks', 'thank', 'thankyou', 'thx', 'ty', 'ta', 'cheers', 'many', 'much', 'very', 'so', 'lots', 'again', 'you', 'all', 'for', 'the', 'your', 'this', 'that', 'it',
  'received', 'noted', 'got', 'will', 'do', 'appreciated', 'appreciate', 'grateful', 'great', 'brilliant', 'lovely', 'perfect', 'excellent', 'wonderful', 'fab', 'fantastic', 'super', 'amazing', 'awesome', 'nice', 'kind', 'kindly', 'help', 'update', 'info', 'information', 'email', 'message', 'letting', 'me', 'us', 'know',
  'hi', 'hello', 'hey', 'dear', 'morning', 'afternoon', 'evening', 'good',
  'regards', 'best', 'wishes', 'warm', 'speak', 'soon', 'have', 'a', 'day', 'weekend', 'and', 'with', 'x', 'xx', 'xxx',
]);

/**
 * Whether an email is only an acknowledgement ("Will do, cheers", "Thanks, received"), so nobody needs to
 * reply. Deliberately strict: every word must be one of ACK_WORDS once the greeting, the sender's own
 * name and the sign-off are set aside; no question, no number, no "but"/"not", nothing attached, and short.
 * Anything it cannot be sure of is not an acknowledgement, and goes to a person.
 */
export function isAcknowledgement(text: string, senderName?: string | null, attachments = 0): boolean {
  if (attachments > 0) return false;
  const raw = text.replace(/^(sent from my .*|get outlook for .*)$/gim, '').trim();
  if (!raw || raw.length > 160) return false;
  if (/[?£$€\d]/.test(raw)) return false;
  const name = new Set((senderName ?? '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 1));
  const words = raw.toLowerCase().replace(/\b(no problems?|no worries)\b/g, ' ').replace(/[’']/g, '').split(/[^a-z]+/).filter(Boolean).filter((w) => !name.has(w));
  if (!words.length || words.length > 15) return false;
  if (!words.some((w) => /^(thanks|thank|thankyou|thx|ty|ta|cheers|received|noted|appreciated|grateful|will)$/.test(w))) return false;
  if (words.includes('will') && !/\bwill do\b/.test(words.join(' '))) return false;
  return words.every((w) => ACK_WORDS.has(w));
}
