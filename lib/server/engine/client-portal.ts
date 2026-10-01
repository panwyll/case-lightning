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
  | { type: 'reply'; label: string };
export interface PortalTask { id: string; title: string; detail: string; since: string; action: PortalAction }
export interface PortalProgress { id: string; label: string; state: 'done' | 'in_progress' | 'with_you' | 'not_started' }
export interface ClientPortalView {
  side: 'buyer' | 'seller' | 'owner';
  transaction: string;
  closed: boolean;
  journey: PortalStep[];
  stageLabel: string;
  progress: PortalProgress[];
  tasks: PortalTask[];
  waitingOnOthers: Array<{ who: string; what: string[] }>;
  dates: { targetExchange: string | null; exchanged: string | null; completion: string | null; targetCompletion: string | null; completed: string | null };
}

/** The steps a client recognises, per kind of case (the engine's finer stages sit inside them). */
const JOURNEY_LABEL: Record<string, Record<string, string>> = {
  buyer: { instructed: 'Getting Started', pre_exchange: 'Searches, Checks And Enquiries', ready_to_exchange: 'Ready To Exchange', exchanged: 'Exchanged', completed: 'Completed' },
  seller: { instructed: 'Getting Started', pre_exchange: 'Contract Pack And Enquiries', ready_to_exchange: 'Ready To Exchange', exchanged: 'Exchanged', completed: 'Completed' },
  owner: { instructed: 'Getting Started', investigating: 'Checks', ready_to_complete: 'Ready To Complete', completed: 'Completed' },
};
/** Where the finer lifecycle states sit on the client's steps. */
const ON_STEP: Record<string, string> = { pre_completion: 'exchanged', post_completion: 'completed', closed: 'completed' };

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
      return { ...base, title: `Identity Check${who}`, detail: 'Upload clear photos of your passport or driving licence, and a bank statement or utility bill from the last three months.', action: { type: 'upload', label: 'Upload ID', role: null } };
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
      return { ...base, title: 'Documents To Sign', detail: `${deeds.length ? `To sign: ${deeds.map((d) => d.label).join(', ')}. ` : ''}Sign where shown, with a witness where the document asks for one, and post the originals to us. Upload a photo or scan so we know they are on the way.`, action: { type: 'upload', label: 'Upload A Copy', role: null } };
    }
    case 'mortgage_offer':
      return { ...base, title: 'Mortgage Offer', detail: 'Your lender sends us a copy too. If you have yours, upload it to save time.', action: { type: 'upload', label: 'Upload Your Offer', role: 'mortgage_offer' } };
    case 'survey':
      return { ...base, title: 'Survey', detail: 'Upload your survey report when you have it, and tell us anything in it that worries you.', action: { type: 'upload', label: 'Upload Your Survey', role: 'survey' } };
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

export function clientPortalView(s: MatterState, now: Date = new Date(), opts: PortalOptions = {}): ClientPortalView {
  const p = profileOf(s.transactionType);
  const b = caseBrief(s, now);
  const side = p.side as ClientPortalView['side'];
  const labels = JOURNEY_LABEL[side] ?? JOURNEY_LABEL.buyer;
  const lc = lifecycle(s);
  const at = ON_STEP[lc] ?? lc;
  const steps = lifecycleFor(p).filter((k) => labels[k]);
  const here = steps.indexOf(at as (typeof steps)[number]);
  const finished = lc === 'completed' || lc === 'post_completion' || lc === 'closed';
  const journey: PortalStep[] = steps.map((k, i) => ({ key: k, label: labels[k], state: finished || i < here ? 'done' : i === here ? 'current' : 'next' }));

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
    closed: lc === 'aborted' || lc === 'closed',
    journey,
    stageLabel: lc === 'aborted' ? 'Closed' : (labels[at] ?? b.lifecycleLabel),
    progress,
    tasks: lc === 'aborted' || finished ? [] : onClient.map((w) => task(s, w, opts)),
    waitingOnOthers: [...byWho].map(([who, what]) => ({ who, what })),
    dates: { targetExchange: b.milestones.targetExchangeDate, exchanged: b.milestones.exchangedAt, completion: b.milestones.completionDate, targetCompletion: b.milestones.targetCompletionDate, completed: b.milestones.completedAt },
  };
}
