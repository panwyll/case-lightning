/**
 * What the client sees on their portal (docs/spec/ui.md "Client portal"): where the case is, what is
 * waiting on them (each with the way to do it), and what we are waiting on from others.
 *
 * Built from the same brief the client updates use, and held to the same rule: it never shows an
 * issue, a decision, a flag or an internal code. A workstream held by an issue reads "In Progress"
 * until the conveyancer tells the client; a problem is never learned from a page.
 */
import { caseBrief, type BriefWait } from './brief';
import { lifecycle, lifecycleFor, workstreams } from './graph';
import type { Workstream } from './issues';
import { profileOf } from './transactions';
import { FORM_NAMES, unsignedDeeds } from './chase-content';
import { isLeasehold, type MatterState } from './types';
import type { DocumentClassification } from './ports';

export interface PortalStep { key: string; label: string; state: 'done' | 'current' | 'next' }
export type PortalAction =
  | { type: 'link'; url: string; label: string }
  | { type: 'upload'; label: string; role: DocumentClassification['role'] | null }
  | { type: 'call'; label: string }
  | { type: 'reply'; label: string }
  | { type: 'questions'; label: string; kind: 'sdlt' | 'cgt'; questions: Array<{ key: string; q: string }> };
export interface PortalTask { id: string; title: string; detail: string; since: string; action: PortalAction }
export interface PortalProgress { id: string; label: string; state: 'done' | 'in_progress' | 'with_you' | 'not_started' }
export interface ClientPortalView {
  side: 'buyer' | 'seller' | 'owner';
  transaction: string;
  /** The engine's lifecycle key (instructed, pre_exchange, exchanged, …), for what the page asks and answers. */
  lifecycle: string;
  leasehold: boolean;
  hasLender: boolean;
  closed: boolean;
  journey: PortalStep[];
  /** The macro stage the case is at (the workflow's sections). */
  stage: MacroStage;
  stageLabel: string;
  progress: PortalProgress[];
  tasks: PortalTask[];
  waitingOnOthers: Array<{ who: string; what: string[] }>;
  dates: { targetExchange: string | null; exchanged: string | null; completion: string | null; targetCompletion: string | null; completed: string | null };
}

/**
 * The workflow's macro stages (the flowchart's sections: WorkPanel PHASES), which the client sees as their steps and
 * which Help is organised by. A remortgage or transfer has no enquiries or exchange of its own.
 */
export const MACRO_STAGES = ['instruction', 'investigation', 'enquiries', 'contract', 'completion', 'registration'] as const;
export type MacroStage = (typeof MACRO_STAGES)[number];
export const MACRO_LABEL: Record<MacroStage, string> = { instruction: 'Instruction', investigation: 'Investigation', enquiries: 'Enquiries', contract: 'Contract & Exchange', completion: 'Completion', registration: 'Registration' };
/** Where each engine stage sits among the macro stages. */
const MACRO_OF: Record<string, MacroStage> = { instruction: 'instruction', pre_contract: 'investigation', contract_review: 'enquiries', pre_exchange: 'contract', exchanged: 'completion', pre_completion: 'completion', completed: 'registration', post_completion: 'registration' };
export const macroStagesFor = (side: string): MacroStage[] => (side === 'owner' ? ['instruction', 'investigation', 'completion', 'registration'] : [...MACRO_STAGES]);
export function macroStageOf(s: MatterState): MacroStage {
  const m = MACRO_OF[s.stage] ?? 'instruction';
  return profileOf(s.transactionType).side === 'owner' && (m === 'enquiries' || m === 'contract') ? 'investigation' : m;
}

const CLIENT_WS: Partial<Record<Workstream, string>> = {
  id_aml: 'Identity Check', source_of_funds: 'Source Of Funds', title: 'Legal Title', searches: 'Searches', enquiries: 'Enquiries', mortgage: 'Mortgage',
  survey: 'Survey', leasehold: 'Leasehold Information', contract: 'Contract', deposit: 'Deposit', report_on_title: 'Report On Title', co_ownership: 'How You Will Own It',
  property_forms: 'Property Forms', redemption: 'Paying Off Your Mortgage', lender_consent: "Lender's Consent", completion: 'Completion', registration: 'Land Registry', discharge: 'Old Mortgage Removed',
};
/** Which of the client's waits belongs to which workstream, so it reads "With You". */
const CLIENT_WAIT_WS: Record<string, Workstream> = { id_check: 'id_aml', proof_of_funds: 'source_of_funds', property_forms: 'property_forms', mortgage_offer: 'mortgage', survey: 'survey', deposit: 'deposit', signed_documents: 'contract', funds: 'completion', insurance: 'completion' };

const MONEY_SAFE = 'Call us before you send any money. We will never change our bank details by email; if an email says we have, do not pay and call us on the number you already have.';

export interface PortalOptions { idProviderSendsLink?: boolean; idProviderLabel?: string }

/** One task per thing waiting on the client, with the way to do it here. */
function task(s: MatterState, w: BriefWait, opts: PortalOptions): PortalTask {
  const id = `${w.key}:${w.subject ?? ''}`;
  const base = { id, since: s.waits.find((x) => x.key === w.key && x.subject === w.subject && !x.closedAt)?.openedAt ?? '' };
  switch (w.key) {
    case 'id_check': {
      const party = w.subject ? s.partyChecks[w.subject] : null;
      const target = party ?? s.idCheck;
      const who = party ? ` For ${party.label}` : '';
      if (target.link) return { ...base, title: `Identity Check${who}`, detail: 'A few minutes on your phone: photos of your ID and a selfie.', action: { type: 'link', url: target.link, label: 'Start Your ID Check' } };
      if (opts.idProviderSendsLink) return { ...base, title: `Identity Check${who}`, detail: `Look for the email from ${opts.idProviderLabel ?? 'our ID provider'} with your link. Tell us if you cannot find it.`, action: { type: 'reply', label: 'I Cannot Find The Email' } };
      return { ...base, title: `Identity Check${who}`, detail: 'Upload photos of your passport or driving licence, and a bank statement or bill from the last three months.', action: { type: 'upload', label: 'Upload ID', role: null } };
    }
    case 'proof_of_funds':
      return s.proofOfFunds.formUrl
        ? { ...base, title: 'Proof Of Funds', detail: 'Tell us where the money for the purchase is coming from, and connect your bank or upload statements.', action: { type: 'link', url: s.proofOfFunds.formUrl, label: 'Open The Form' } }
        : { ...base, title: 'Proof Of Funds', detail: 'We will send you the form shortly.', action: { type: 'reply', label: 'Ask Us About It' } };
    case 'property_forms': {
      const forms = (s.propertyForms.forms.length ? s.propertyForms.forms : isLeasehold(s) ? ['TA6', 'TA10', 'TA7'] : ['TA6', 'TA10']).map((f) => FORM_NAMES[f] ?? f);
      return { ...base, title: 'Property Forms', detail: `Fill in and upload: ${forms.join(', ')}.`, action: { type: 'upload', label: 'Upload Forms', role: 'property_forms' } };
    }
    case 'signed_documents': {
      const deeds = unsignedDeeds(s);
      return { ...base, title: 'Documents To Sign', detail: `${deeds.length ? `To sign: ${deeds.map((d) => d.label).join(', ')}. ` : ''}Sign where shown (with a witness where asked) and post the originals to us. Upload a photo so we know they are coming.`, action: { type: 'upload', label: 'Upload A Copy', role: null } };
    }
    case 'mortgage_offer':
      return { ...base, title: 'Mortgage Offer', detail: 'Your lender sends us a copy too. If you have yours, upload it to save time.', action: { type: 'upload', label: 'Upload Your Offer', role: 'mortgage_offer' } };
    case 'survey':
      return { ...base, title: 'Survey', detail: 'Upload the report when you have it.', action: { type: 'upload', label: 'Upload Your Survey', role: 'survey' } };
    case 'deposit':
      return { ...base, title: 'Deposit', detail: MONEY_SAFE, action: { type: 'call', label: 'Call Us' } };
    case 'funds':
      return { ...base, title: 'Completion Money', detail: MONEY_SAFE, action: { type: 'call', label: 'Call Us' } };
    case 'insurance':
      return { ...base, title: 'Buildings Insurance', detail: 'Upload the schedule for buildings insurance that starts on exchange.', action: { type: 'upload', label: 'Upload The Schedule', role: null } };
    case 'client_decision':
      return { ...base, title: 'Your Decision', detail: `We need your instructions on ${w.what}. Reply to our email or call us.`, action: { type: 'reply', label: 'Reply To Us' } };
    default:
      return { ...base, title: w.what.charAt(0).toUpperCase() + w.what.slice(1), detail: `We are waiting for ${w.what} from you.`, action: { type: 'upload', label: 'Upload', role: null } };
  }
}

/** The tax questions the client answers themselves (sdlt-facts.ts), until they or we have recorded the answers. */
export const SDLT_QUESTIONS: Array<{ key: string; q: string }> = [
  { key: 'mainResidence', q: 'Will it be your only or main home?' },
  { key: 'anyEverOwned', q: 'Has any of you ever owned a home, or a share of one, anywhere in the world (including one you inherited)?' },
  { key: 'anyOwnsOther', q: 'At the end of the completion day, will any of you (or your husband, wife or civil partner) own another home, or a share of one, worth £40,000 or more, anywhere in the world?' },
  { key: 'replacing', q: 'Are you selling the home you live in now?' },
  { key: 'replacingFirst', q: 'If so, will that sale complete on or before the day you buy?' },
  { key: 'anyNonResident', q: 'Has any of you spent fewer than 183 days in the UK in the last 12 months?' },
];
export const CGT_QUESTIONS: Array<{ key: string; q: string }> = [
  { key: 'mainResidenceThroughout', q: 'Has it been your only or main home for the whole time you have owned it?' },
  { key: 'ukResident', q: 'Are you UK resident for tax?' },
];
function taxTask(s: MatterState, side: ClientPortalView['side']): PortalTask[] {
  if (s.exchange.exchangedAt) return [];
  const since = s.waits[0]?.openedAt ?? new Date().toISOString();
  if ((side === 'buyer' || s.transactionType === 'transfer_of_equity') && !s.sdltFacts) return [{ id: 'tax:sdlt', title: 'Tax Questions', detail: 'A few questions that decide how much Stamp Duty you pay. Answer for everyone buying.', since, action: { type: 'questions', label: 'Answer The Questions', kind: 'sdlt', questions: SDLT_QUESTIONS } }];
  if (side === 'seller' && !s.cgtFacts) return [{ id: 'tax:cgt', title: 'Tax Questions', detail: 'Two questions about the property, so we can tell you if you need to report the sale to HMRC.', since, action: { type: 'questions', label: 'Answer The Questions', kind: 'cgt', questions: CGT_QUESTIONS } }];
  return [];
}

export function clientPortalView(s: MatterState, now: Date = new Date(), opts: PortalOptions = {}): ClientPortalView {
  const p = profileOf(s.transactionType);
  const b = caseBrief(s, now);
  const side = p.side as ClientPortalView['side'];
  const lc = lifecycle(s);
  const stage = macroStageOf(s);
  const steps = macroStagesFor(side);
  const here = steps.indexOf(stage);
  // Registration done (or the file closed): every step is done.
  const finished = lc === 'closed' || !!s.postCompletion?.ap1ConfirmedAt;
  const journey: PortalStep[] = steps.map((k, i) => ({ key: k, label: MACRO_LABEL[k], state: finished || i < here ? 'done' : i === here ? 'current' : 'next' }));

  const onClient = b.waiting.filter((w) => w.role === 'client');
  const withYou = new Set(onClient.map((w) => CLIENT_WAIT_WS[w.key]).filter(Boolean));
  const progress: PortalProgress[] = workstreams(s, now)
    .filter((w) => w.status !== 'not_applicable' && CLIENT_WS[w.id])
    .map((w) => ({ id: w.id, label: CLIENT_WS[w.id]!, state: w.status === 'complete' ? 'done' : withYou.has(w.id) ? 'with_you' : w.status === 'not_started' ? 'not_started' : 'in_progress' }));

  const byWho = new Map<string, string[]>();
  for (const w of b.waiting.filter((x) => x.role !== 'client')) byWho.set(w.who, Array.from(new Set([...(byWho.get(w.who) ?? []), w.what])));

  return {
    side,
    transaction: b.transactionLabel,
    lifecycle: lc,
    leasehold: isLeasehold(s),
    hasLender: !!s.hasLender,
    closed: lc === 'aborted' || lc === 'closed',
    journey,
    stage,
    stageLabel: lc === 'aborted' ? 'Closed' : MACRO_LABEL[stage],
    progress,
    tasks: lc === 'aborted' || finished || ['completed', 'post_completion'].includes(lc) ? [] : [...taxTask(s, side), ...onClient.map((w) => task(s, w, opts))],
    waitingOnOthers: [...byWho].map(([who, what]) => ({ who, what })),
    dates: { targetExchange: b.milestones.targetExchangeDate, exchanged: b.milestones.exchangedAt, completion: b.milestones.completionDate, targetCompletion: b.milestones.targetCompletionDate, completed: b.milestones.completedAt },
  };
}
