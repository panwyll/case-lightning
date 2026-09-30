/**
 * The reply to an email, built from the case (docs/spec/triggers.md). Every point the writer
 * made is answered from what the engine knows: what is done, what is waiting and on whom, what is
 * next and when. The model only words it; without one, the reply is assembled from the same facts.
 * Nothing goes until a person approves it, as drafted or edited.
 */
import { caseBrief, clientStatusAnswer, renderForDrafting } from './brief';
import { CERTIFICATE_OF_TITLE_NOTICE } from './sla';
import { profileOf } from './transactions';
import { WAIT_LABEL } from './notes';
import type { MatterState, NoteAction } from './types';

/** The case as facts for a reply: the drafting brief, plus the timing facts people ask about ("can we complete by Friday?"). */
export function replyFacts(s: MatterState, now: Date): string {
  const b = caseBrief(s, now);
  const L = [renderForDrafting(b)];
  const side = profileOf(s.transactionType).side;
  const T: string[] = [];
  if (!s.exchange.exchangedAt && side !== 'owner') {
    const before = b.nextActions.filter((a) => /exchange/i.test(a.unblocks ?? '') || !a.unblocks).map((a) => a.what);
    T.push(`- Not exchanged yet. Completion cannot happen before exchange (they can be on the same day only when everything for both is ready).${before.length ? ` Still to do before exchange: ${before.join('; ')}.` : ''}`);
  }
  if (s.hasLender && !s.completion.confirmedAt) T.push(`- The lender needs our certificate of title ${CERTIFICATE_OF_TITLE_NOTICE} working days before completion to release the mortgage money; completion cannot be sooner than that from when everything is ready.`);
  if (s.exchange.completionDate) T.push(`- The contractual completion date is ${s.exchange.completionDate}.`);
  else if (s.targetCompletionDate) T.push(`- The target completion date (a plan, not agreed in a contract) is ${s.targetCompletionDate.slice(0, 10)}.`);
  const reported = s.waits.filter((w) => !w.closedAt && w.reported).map((w) => `${WAIT_LABEL[w.key]}: they said "${w.reported!.claim}" (${w.reported!.at.slice(0, 10)})`);
  if (reported.length) T.push(`- Reported by the client as done or on its way (not yet arrived): ${reported.join('; ')}.`);
  if (T.length) L.push(['TIMING (facts; never promise a date these do not support):', ...T].join('\n'));
  // What the client has told us that nobody has recorded yet: a reply must not contradict it (a withdrawn offer is not "under review").
  const openKinds = new Set(Object.values(s.issues).filter((i) => i.status === 'open' || i.status === 'negotiating').map((i) => i.kind));
  const seen = new Set<string>();
  const told = Object.values(s.notes).filter((n) => n.status === 'proposed' && n.from?.relation === 'client').flatMap((n) => n.actions
    .filter((a) => a.command && (a.command.type === 'raise_issue' || a.command.type === 'record_mortgage_withdrawn'))
    // Already on the file as an issue of that kind, or said twice: once is enough.
    .filter((a) => !(a.command!.type === 'raise_issue' && openKinds.has(a.command!.kind)))
    .filter((a) => { const k = a.quote.toLowerCase().replace(/[^a-z]+/g, ' ').trim(); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((a) => `- "${a.quote.slice(0, 160)}" (${n.at.slice(0, 10)}): ${a.summary}`));
  if (told.length) L.push(['REPORTED BY THE CLIENT, NOT YET CONFIRMED ON THE FILE (take it as what they told us; never contradict it, never say the opposite is the case):', ...told].join('\n'));
  return L.join('\n');
}

/** Without a model: the reply assembled from the same facts, point by point, then where things stand. */
export function templateReply(s: MatterState, now: Date, input: { firstName: string | null; lines: NoteAction[]; others?: string[]; /** What the rules add to the reply (recipients.ts): asked here rather than in a second email. */ also?: string[]; /** Files attached to the reply (a document they asked for). */ attached?: Array<{ fileName: string; what: string }> }): string {
  const P: string[] = [`Hello ${input.firstName ?? 'there'},`, 'Thank you for your email.'];
  for (const a of input.lines) {
    const c = a.command;
    if (c?.type === 'record_client_progress') P.push(`Thank you for letting us know about ${WAIT_LABEL[c.waitKey]}. We will look out for it and let you know when it has arrived.`);
    else if (c?.type === 'resend_to_client') P.push(`We have sent the request for ${WAIT_LABEL[c.waitKey]} again, with the links you need.`);
    else if (c?.type === 'send_file_copy') { const files = (input.attached ?? []).filter((x) => x.what === c.what).map((x) => x.fileName); P.push(files.length ? `I attach ${files.join(', ')}.` : `We will send you ${c.what.trim()} as soon as we can.`); }
    else if (a.kind === 'question') P.push(`On your question ("${a.quote.slice(0, 120)}"): we are checking and will come back to you shortly.`);
  }
  for (const a of input.also ?? []) P.push(a);
  if (input.others?.length) P.push(`We are writing to ${input.others.join(' and ')} today and will let you know what they say.`);
  const status = clientStatusAnswer(caseBrief(s, now), now);
  if (status.canAnswer) P.push(status.text);
  return P.join('\n\n');
}

/** Without a model: a message to someone other than the writer, from its purposes and the case. */
export function templateMessage(s: MatterState, to: Exclude<import('./types').MessageParty, 'client'>, sentences: string[], property: string | null): string {
  const where = property ? ` in the matter of ${property}` : '';
  const side = profileOf(s.transactionType).side === 'seller' ? 'seller' : 'buyer';
  const said = sentences.join(' ');
  if (to === 'seller_solicitor') return `Dear Colleagues,\n\nWe act for the ${side}${where}. ${said}\n\nWe look forward to hearing from you.`;
  return `Hello,\n\nWe act for the ${side}${where}. ${said}`;
}

/** Without a model: a message about an issue on the case (issues.ts `issueSteps`): the step's sentence, naming the issue where it says `{issue}`. */
export function templateIssueMessage(s: MatterState, to: import('./types').MessageParty, input: { sentence: string; issueTitle: string; firstName: string | null; property: string | null }): string {
  const title = input.issueTitle.trim().replace(/\.$/, '');
  const said = input.sentence.replace('{issue}', /^[A-Z][a-z]/.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title);
  if (to === 'client') return `Hello ${input.firstName ?? 'there'},\n\n${said}`;
  return templateMessage(s, to, [said], input.property);
}
