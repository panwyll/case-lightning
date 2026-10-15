/**
 * The onboarding measurement (docs/epa-categories.md, "The measurement phase"): from each conveyancer's mailbox scan and
 * InTouch, a typical week for the firm in the same categories and colours as Analytics → Time, and the headline: at most this
 * share of the week moves cases on. Pure; the route loads.
 *
 * Red and amber are measured: what was sent, how often, times the minutes each took (Outlook's own draft-to-send timing where
 * at least ten were timed, else the typical minutes below). Green cannot be seen in an inbox (reading a title leaves no
 * trace), so it is what is left of the contracted week: an upper bound, which errs in the firm's favour.
 *
 * Below MIN_SENT_PER_WEEK case emails sent a week per person the page warns that not much data was found (it still draws it).
 */
import { actsUnasked, levelFor, ENGINE_ACTION_LABEL, type LevelConfig } from '../engine/types';
import { ACTION_FOR, type ParetoBar, type RagSplit } from './report';
import { EPA_KINDS, EPA_SPEC, fromEmail, type EpaKind } from './taxonomy';

/** Minutes each when Outlook did not time enough of them: what this work typically takes. */
export const TYPICAL_MINUTES: Partial<Record<EpaKind, number>> = {
  client_chasers: 4, other_side_chasers: 4, lender_chasers: 4, agent_chasers: 3, third_party_chasers: 4,
  client_any_news: 5, agent_status_requests: 4, other_side_status_requests: 4, lender_broker_status_requests: 4,
  client_updates: 7, agent_updates: 4, other_side_updates: 5, lender_broker_updates: 4,
  resending_to_client: 5, resending_to_others: 4, first_requests_client: 4, first_requests_others: 4,
  sending_documents_client: 6, sending_documents_others: 5, acknowledging: 1.5, filing: 2, notes_and_outcomes: 4,
  client_process_questions: 6, client_legal_questions: 10, arranging_dates: 4, legal_correspondence: 10,
};
/** Below this many case emails sent a week per person, the page warns that not much data was found. */
export const MIN_SENT_PER_WEEK = 20;
/** Timed emails needed before Outlook's timing replaces the typical minutes. */
const TIMED_ENOUGH = 10;

/** One group of a scan's sent email: its category, who it went to, how many, and Outlook's timing of them. */
export interface SentGroup { category: string; roles: string[]; count: number; timed: number; timedMedianMinutes: number | null }
/** One group of received email, for what causes the work. */
export interface ReceivedGroup { category: string; roles: string[]; count: number }
export interface PersonScan {
  weeks: number;
  sent: SentGroup[];
  received: ReceivedGroup[];
  intouch: { live: number; openedInWindow: number; filedByFirm: { email: number; note: number; call: number; document: number }; filedByOthers: number; error?: string | null } | null;
}

export interface MeasuredLine extends ParetoBar { minutesBasis: 'timed' | 'typical' | 'intouch' }
export interface Measurement {
  people: number;
  contractedHours: number;
  /** A typical week for the whole firm. */
  hours: RagSplit;
  share: RagSplit;
  /** At most this share of the week moves cases on (green ÷ contracted). */
  movesCasesOnAtMost: number;
  /** Red and amber, biggest first, with how often a week and the minutes each. */
  lines: MeasuredLine[];
  /** Green the inbox does show (legal email), inside the "at most". */
  greenMeasuredHours: number;
  /** What causes the red, a week: status requests and chasers received. */
  received: { clientStatusRequests: number; agentStatusRequests: number; otherSideStatusRequests: number; chasersReceived: number };
  /** Case email sent a week per person: below a believable volume the page warns, and still draws the week. */
  sentPerPersonWeek: number;
  /** From InTouch, when it was read. */
  cases: { live: number; perConveyancer: number | null; openedPerWeek: number | null } | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function buildMeasurement(input: { people: PersonScan[]; contractedHours: number; levels: LevelConfig }): Measurement | null {
  const scanned = input.people.filter((p) => p.weeks > 0);
  if (!scanned.length) return null;
  // Per kind, firm-wide, a week: count and minutes.
  const perWeek = new Map<EpaKind, { count: number; minutes: number; timed: number; basis: MeasuredLine['minutesBasis'] }>();
  const add = (k: EpaKind, count: number, minutes: number, basis: MeasuredLine['minutesBasis'], timed = 0) => {
    const cur = perWeek.get(k) ?? { count: 0, minutes: 0, timed: 0, basis };
    cur.count += count; cur.minutes += minutes; cur.timed += timed;
    if (basis === 'timed') cur.basis = 'timed';
    perWeek.set(k, cur);
  };
  const received = { clientStatusRequests: 0, agentStatusRequests: 0, otherSideStatusRequests: 0, chasersReceived: 0 };
  let live = 0;
  let opened = 0;
  let intouchPeople = 0;
  let sentCase = 0;
  for (const p of scanned) {
    for (const g of p.sent) {
      const k = fromEmail(g.category, g.roles);
      if (EPA_SPEC[k].rag === 'none') continue;
      sentCase += g.count / p.weeks;
      const timedOk = g.timed >= TIMED_ENOUGH && g.timedMedianMinutes != null;
      const each = timedOk ? g.timedMedianMinutes! : TYPICAL_MINUTES[k] ?? 5;
      add(k, g.count / p.weeks, (g.count / p.weeks) * each, timedOk ? 'timed' : 'typical', g.timed);
    }
    for (const g of p.received) {
      const n = g.count / p.weeks;
      const role = new Set(g.roles);
      if (g.category === 'update_request') {
        if (role.has('client')) received.clientStatusRequests += n;
        else if (role.has('estate_agent')) received.agentStatusRequests += n;
        else received.otherSideStatusRequests += n;
      }
      if (g.category === 'chaser_received') received.chasersReceived += n;
    }
    if (p.intouch && !p.intouch.error) {
      intouchPeople += 1;
      live += p.intouch.live;
      opened += p.intouch.openedInWindow / p.weeks;
      // Filed by hand: documents and notes. Email records are left out: InTouch's own Exchange filing may have put them there.
      const docs = p.intouch.filedByFirm.document / p.weeks;
      const notes = p.intouch.filedByFirm.note / p.weeks;
      if (docs) add('filing', docs, docs * (TYPICAL_MINUTES.filing ?? 2), 'intouch');
      if (notes) add('notes_and_outcomes', notes, notes * (TYPICAL_MINUTES.notes_and_outcomes ?? 4), 'intouch');
    }
  }

  const contracted = scanned.length * input.contractedHours;
  const hrs = { red: 0, amber: 0 };
  let greenMeasured = 0;
  for (const [k, v] of perWeek) {
    const rag = EPA_SPEC[k].rag;
    if (rag === 'red' || rag === 'amber') hrs[rag] += v.minutes / 60;
    if (rag === 'green') greenMeasured += v.minutes / 60;
  }
  // Green is the rest of the week, never less than the legal email the inbox does show.
  const green = Math.max(greenMeasured, contracted - hrs.red - hrs.amber);
  const total = hrs.red + hrs.amber + green;
  const hours = { red: r1(hrs.red), amber: r1(hrs.amber), green: r1(green) };

  const routine = EPA_KINDS.filter((k) => (EPA_SPEC[k].rag === 'red' || EPA_SPEC[k].rag === 'amber') && (perWeek.get(k)?.minutes ?? 0) > 0)
    .sort((a, b) => perWeek.get(b)!.minutes - perWeek.get(a)!.minutes);
  const routineMinutes = routine.reduce((a, k) => a + perWeek.get(k)!.minutes, 0);
  let cum = 0;
  const lines: MeasuredLine[] = routine.map((k) => {
    const v = perWeek.get(k)!;
    cum += v.minutes;
    const key = ACTION_FOR[k];
    const level = key ? levelFor(input.levels, key) : null;
    return {
      kind: k, label: EPA_SPEC[k].label, rag: EPA_SPEC[k].rag as 'red' | 'amber', hours: r2(v.minutes / 60), share: v.minutes / routineMinutes, cumulative: cum / routineMinutes,
      times: Math.round(v.count), avgMinutes: v.count ? r1(v.minutes / v.count) : null,
      action: key && level ? { key, label: ENGINE_ACTION_LABEL[key], level, sendsUnasked: actsUnasked(level, key) } : null,
      minutesBasis: v.basis,
    };
  });
  return {
    people: scanned.length,
    contractedHours: input.contractedHours,
    hours,
    share: { red: hrs.red / total, amber: hrs.amber / total, green: green / total },
    movesCasesOnAtMost: contracted ? Math.min(1, green / contracted) : 0,
    lines,
    greenMeasuredHours: r1(greenMeasured),
    sentPerPersonWeek: r1(sentCase / scanned.length),
    received: { clientStatusRequests: Math.round(received.clientStatusRequests), agentStatusRequests: Math.round(received.agentStatusRequests), otherSideStatusRequests: Math.round(received.otherSideStatusRequests), chasersReceived: Math.round(received.chasersReceived) },
    cases: intouchPeople ? { live, perConveyancer: r1(live / intouchPeople), openedPerWeek: r1(opened) } : null,
  };
}
